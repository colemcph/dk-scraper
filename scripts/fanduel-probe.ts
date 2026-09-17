/**
 * FanDuel reachability + freshness probe: "what does THIS host see from FanDuel's page API?"
 *
 *   npm run probe:fanduel                         # ~45 s: reachability, one read, the cache cycle
 *   PROBE_SECONDS=90 npm run probe:fanduel        # longer cycle (two full max-age windows = 60 s)
 *   FD_CACHE_BYPASS=true npm run probe:fanduel    # also compares origin reads with the edge copy
 *
 * What it shows, in order:
 *   1. curl and Node both get 200 (no TLS fingerprinting, unlike DraftKings' Akamai).
 *   2. One full read: status, bytes, Cache-Control, ETag, Age, X-Cache, how many games parsed.
 *   3. A conditional read with If-None-Match: 304, no body.
 *   4. One request per second: the Age header climbing to max-age and resetting, and the moment
 *      the ETag changes (= a new copy at the edge). Prints how many polls the app's cache-aware
 *      scheduler would have made over the same window instead.
 *   5. With FD_CACHE_BYPASS=true: origin reads (X-Cache: Miss) and whether their ETag differs from
 *      the edge copy, i.e. whether bypassing actually buys fresher data right now.
 *
 * Run it during a live game to see prices move; on a quiet evening the ETag may not change at all.
 */
import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { promisify } from 'node:util';
import { nextPollDelayMs } from '../src/server/fanduel/adapter.js';
import { normalizeFanDuelPage } from '../src/server/fanduel/normalize.js';
import { FdRestClient } from '../src/server/fanduel/rest.js';
import { BROWSER_USER_AGENT } from '../src/server/http.js';
import { loadConfig } from '../src/server/config.js';

const execFileP = promisify(execFile);
const config = loadConfig();
const seconds = Number(process.env.PROBE_SECONDS ?? 45);
const league = {
  id: config.fd.pageId,
  name: config.fd.leagueName || config.fd.pageId.toUpperCase(),
};
const client = new FdRestClient({
  region: config.fd.region,
  apiKey: config.fd.apiKey,
  timezone: config.fd.timezone,
  ...(config.fd.restBaseUrl ? { baseUrl: config.fd.restBaseUrl } : {}),
});
const url = client.pageUrl(league.id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const s = (ms: number | null) => (ms === null ? '—' : `${Math.round(ms / 1000)}s`);

console.log(
  `probe: region=${config.fd.region} page=${league.id} node=${process.version}\n  ${url.replace(config.fd.apiKey, '<key>')}\n`,
);

// 1. curl vs Node (devNull: Windows' own curl.exe rejects /dev/null)
try {
  const { stdout } = await execFileP('curl', [
    '-s',
    '-o',
    devNull,
    '-w',
    '%{http_code}',
    '-A',
    BROWSER_USER_AGENT,
    url,
  ]);
  console.log(`1. curl  -> HTTP ${stdout.trim() || '(no status)'}`);
} catch (err) {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  const detail = e.stdout?.trim() || e.stderr?.trim().split('\n')[0] || e.message?.split('\n')[0];
  console.log(`1. curl  -> ${detail ?? String(err)}`);
}

// 2. one full read
const first = await client.fetchPage(league.id);
const normalized = first.body ? normalizeFanDuelPage(first.body, league, first.fetchedAt) : null;
console.log(
  `   node  -> HTTP ${first.status} in ${first.durationMs} ms · max-age ${s(first.maxAgeMs)} · age ${s(first.ageMs)} · ${first.cacheHit === null ? 'no x-cache' : first.cacheHit ? 'edge hit' : 'edge miss'} · etag ${first.etag ?? '—'}`,
);
console.log(
  `2. parsed ${normalized?.games.length ?? 0} games (${normalized?.games.filter((g) => g.status === 'live').length ?? 0} live), ${normalized?.invalidEntities ?? 0} invalid entities`,
);
for (const g of normalized?.games.slice(0, 3) ?? []) {
  const ml = g.markets.moneyline?.sides;
  console.log(
    `     ${g.away.shortName} @ ${g.home.shortName}  ${g.startTime}  ML ${ml?.away?.odds.american ?? '—'} / ${ml?.home?.odds.american ?? '—'}  spread ${g.markets.spread?.sides.home?.line ?? '—'}  total ${g.markets.total?.sides.over?.line ?? '—'}${g.status === 'live' ? '  LIVE' : ''}`,
  );
}

// 3. conditional read
const cond = await client.fetchPage(league.id);
console.log(
  `3. If-None-Match -> HTTP ${cond.status}${cond.notModified ? ' Not Modified (no body)' : ' (new body)'} in ${cond.durationMs} ms\n`,
);

// 4. the cache cycle at 1 req/s
console.log(
  `4. ${seconds} s at one request per second (the app polls far less: see the last line)`,
);
let lastEtag = cond.etag ?? first.etag;
let changes = 0;
let scheduled = 0;
let nextScheduledAt = Date.now();
const started = Date.now();
while (Date.now() - started < seconds * 1000) {
  const t = Date.now();
  const r = await client.fetchPage(league.id).catch((err: unknown) => {
    console.log(
      `   ${new Date(t).toISOString().slice(11, 19)} ERROR ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });
  if (r) {
    const changed = r.etag !== lastEtag;
    if (changed) changes++;
    lastEtag = r.etag;
    if (t >= nextScheduledAt) {
      scheduled++;
      nextScheduledAt = t + nextPollDelayMs(r, config.fd.pollIntervalMs, config.fd.bypassCache);
    }
    console.log(
      `   ${new Date(t).toISOString().slice(11, 19)} ${r.status} ${String(r.durationMs).padStart(4)} ms  age ${String(s(r.ageMs)).padStart(3)}  ${r.cacheHit ? 'hit ' : 'miss'}  etag ${(r.etag ?? '—').slice(0, 16)}${changed ? '  <- NEW COPY' : ''}`,
    );
  }
  await sleep(Math.max(0, 1000 - (Date.now() - t)));
}
console.log(
  `   -> ${changes} new edge cop${changes === 1 ? 'y' : 'ies'} in ${seconds} s; the age-aware scheduler (base ${config.fd.pollIntervalMs} ms) would have made ${scheduled} requests instead of ${seconds}.\n`,
);

// 5. origin reads, if asked
if (config.fd.bypassCache) {
  console.log('5. FD_CACHE_BYPASS=true: five origin reads vs the edge copy');
  const edge = await client.fetchPage(league.id);
  const bypass = new FdRestClient({
    region: config.fd.region,
    apiKey: config.fd.apiKey,
    timezone: config.fd.timezone,
    bypassCache: true,
    ...(config.fd.restBaseUrl ? { baseUrl: config.fd.restBaseUrl } : {}),
  });
  for (let i = 0; i < 5; i++) {
    const r = await bypass.fetchPage(league.id);
    console.log(
      `   origin ${r.status} ${String(r.durationMs).padStart(4)} ms  ${r.cacheHit ? 'hit ' : 'miss'}  etag ${(r.etag ?? '—').slice(0, 16)}  ${r.etag === edge.etag ? 'same as edge copy' : 'DIFFERENT from edge copy'}`,
    );
    await sleep(1000);
  }
} else {
  console.log('5. (set FD_CACHE_BYPASS=true to also measure origin reads)');
}
