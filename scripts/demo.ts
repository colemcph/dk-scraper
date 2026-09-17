/**
 * Guided interview demo. Three acts, narrated, with pauses between them.
 *
 *   npm run demo                                              # NFL (quiet outside game windows)
 *   DK_LEAGUE_ID=84240 DK_SUBCATEGORY_ID=4519 npm run demo    # MLB (in play most evenings)
 *   NONSTOP=1 npm run demo                                    # no "press Enter" pauses
 *
 * Act 1  Why Node — same request, curl is blocked by Akamai's TLS fingerprint, Node is not.
 * Act 2  How the feed is derived — the socket URL from DraftKings' own page config, the subscribe
 *        envelope from their bundle, and the query filter from the snapshot's subscriptionPartials.
 * Act 3  Latency — subscribe and decompose each update into DraftKings' share and ours, with the
 *        clock-skew self-check.
 *
 * Nothing here is sent to DraftKings beyond the same subscribe message their own page sends.
 */
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { loadConfig } from '../src/server/config.js';

const execFileP = promisify(execFile);
const config = loadConfig();
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const SNAPSHOT_URL = `https://sportsbook-nash.draftkings.com/api/sportscontent/${config.dk.site}/v1/leagues/${config.dk.leagueId}`;
const PAGE_URL = 'https://sportsbook.draftkings.com/leagues/football/nfl';
const DURATION_MS = Number(process.env.DURATION_MS ?? 30_000);

const line = (s = '') => console.log(s);
const banner = (n: number, title: string) =>
  line(`\n${'='.repeat(72)}\n  ACT ${n}: ${title}\n${'='.repeat(72)}`);

async function pause(): Promise<void> {
  if (process.env.NONSTOP || !process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((r) =>
    rl.question('\n(press Enter to continue)\n', () => (rl.close(), r())),
  );
}

/* ------------------------------------------------------------------ Act 1: why Node */

async function curlStatus(): Promise<string> {
  try {
    const { stdout } = await execFileP('curl', [
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-A',
      UA,
      SNAPSHOT_URL,
    ]);
    return stdout.trim() || '(no status)';
  } catch (err) {
    // curl writes the HTTP code to stdout even on a 403; some platforms still exit non-zero.
    const e = err as { stdout?: string; message?: string };
    if (e.stdout && e.stdout.trim()) return e.stdout.trim();
    return e.message ? (e.message.split('\n')[0] ?? String(err)) : String(err);
  }
}

async function actWhyNode(): Promise<void> {
  banner(1, 'Why Node — the same request, two different answers');
  line(`Request: GET ${SNAPSHOT_URL}`);
  line('Both send the same browser User-Agent. The only difference is the client.\n');

  const curlCode = await curlStatus();
  line(
    `  curl  -> HTTP ${curlCode}   ${curlCode === '403' ? '(Akamai "Access Denied" at the edge)' : ''}`,
  );

  try {
    const res = await fetch(SNAPSHOT_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    const body = (await res.json()) as { events?: unknown[] };
    line(`  node  -> HTTP ${res.status}   (${body.events?.length ?? 0} games, JSON)`);
  } catch (err) {
    line(`  node  -> error ${err instanceof Error ? err.message : String(err)}`);
  }

  line('\nAkamai fingerprints the TLS handshake, before any header or cookie is read.');
  line("curl's fingerprint is on a bot list; Node's native client looks like a browser.");
  line('That measurement, not a preference, is why the project is in Node.');
}

/* ------------------------------------------------------------------ Act 2: derive the feed */

interface SubscriptionPartial {
  entity: string;
  query: string;
  includeMarkets?: string;
}

async function actDeriveFeed(): Promise<SubscriptionPartial & { wsUrl: string; siteName: string }> {
  banner(2, 'How the feed is derived — DraftKings tells you, three times');

  line('2a. The socket URL is in the page DraftKings serves:');
  const html = await (await fetch(PAGE_URL, { headers: { 'User-Agent': UA } })).text();
  const wsBase = /"sportsDataBaseWebSocketUrl":"([^"]+)"/.exec(html)?.[1] ?? '';
  const fmt = /"sportsDataBaseWebSocketFormat":"([^"]+)"/.exec(html)?.[1] ?? '';
  const siteName = /"siteName":"([^"]+)"/.exec(html)?.[1] ?? config.dk.site;
  line(`    sportsDataBaseWebSocketUrl = ${wsBase}`);
  line(
    `    sportsDataBaseWebSocketFormat = ${fmt}   (their page uses msgpack; we will ask for json)`,
  );
  line(`    siteName = ${siteName}`);

  line('\n2b. The subscription query is in the snapshot the page loads:');
  const snap = (await (await fetch(SNAPSHOT_URL, { headers: { 'User-Agent': UA } })).json()) as {
    events?: unknown[];
    subscriptionPartials?: Record<string, SubscriptionPartial>;
  };
  const key = `league-events-${config.dk.leagueId}`;
  const partial = snap.subscriptionPartials?.[key];
  line(`    snapshot: ${snap.events?.length ?? 0} games; subscriptionPartials["${key}"] =`);
  line(
    partial
      ? `      ${JSON.stringify(partial, null, 2).split('\n').join('\n      ')}`
      : '      (not present — would fall back to a built query)',
  );

  const wsUrl = `${wsBase}?format=json&locale=en-US`;
  const spec: SubscriptionPartial = partial ?? {
    entity: 'events',
    query: `$filter=leagueId eq '${config.dk.leagueId}' and clientMetadata/Subcategories/any(s: s/Id eq '${config.dk.subcategoryId}')&$orderBy=startEventDate asc`,
    includeMarkets: `$filter=tags/all(t: t ne 'SportcastBetBuilder') and clientMetadata/subCategoryId eq '${config.dk.subcategoryId}'`,
  };

  line('\n2c. The subscribe envelope (JSON-RPC 2.0) comes from their dkDataLayer bundle.');
  line('    Put together, this is the exact message we send:');
  const subscribe = {
    jsonrpc: '2.0',
    method: 'subscribe',
    id: 'demo',
    params: {
      entity: spec.entity,
      queryParams: {
        query: spec.query,
        ...(spec.includeMarkets ? { includeMarkets: spec.includeMarkets } : {}),
        initialData: false,
        projection: 'sportsbook',
        locale: 'en-US',
      },
      forwardedHeaders: {},
      clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': 'unknown' },
      jwt: '',
      siteName,
    },
  };
  line(`\n${JSON.stringify(subscribe, null, 2)}`);
  line(`\nSocket: ${wsUrl}`);
  line(
    'URL from their config, query from their snapshot, envelope from their bundle. Nothing invented.',
  );
  return { ...spec, wsUrl, siteName };
}

/* ------------------------------------------------------------------ Act 3: latency */

interface Metadata {
  createdTime?: string;
}
interface Frame {
  event?: string;
  websocketPublishTimestamp?: string;
  data?: { metadata?: Metadata };
}

const pct = (arr: number[], p: number): number => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
};
const row = (label: string, v: number[]) =>
  line(
    `  ${label.padEnd(18)} min ${String(Math.min(...v)).padStart(5)}   p50 ${String(pct(v, 0.5)).padStart(5)}   p95 ${String(pct(v, 0.95)).padStart(5)}   max ${String(Math.max(...v)).padStart(5)}  ms`,
  );

async function actLatency(
  feed: SubscriptionPartial & { wsUrl: string; siteName: string },
): Promise<void> {
  banner(3, `Latency — subscribe for ${DURATION_MS / 1000}s and split each update`);
  line('inside DraftKings = createdTime -> websocketPublishTimestamp   (their clocks only)');
  line('network           = websocketPublishTimestamp -> our receipt   (clock-skew corrected)');
  line(
    'Skew is estimated from the subscribe round trip; the check is that network is never negative.\n',
  );

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(feed.wsUrl);
    const t0 = Date.now();
    let skewMs = 0;
    let sentAt = 0;
    const inside: number[] = [];
    const network: number[] = [];
    const total: number[] = [];

    ws.onopen = () => {
      sentAt = Date.now();
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'subscribe',
          id: 'demo',
          params: {
            entity: feed.entity,
            queryParams: {
              query: feed.query,
              ...(feed.includeMarkets ? { includeMarkets: feed.includeMarkets } : {}),
              initialData: false,
              projection: 'sportsbook',
              locale: 'en-US',
            },
            forwardedHeaders: {},
            clientMetadata: {
              feature: 'league',
              'X-Client-Name': 'web',
              'X-Client-Version': 'unknown',
            },
            jwt: '',
            siteName: feed.siteName,
          },
        }),
      );
    };

    ws.onmessage = (e) => {
      const received = Date.now();
      let f: Frame;
      try {
        f = JSON.parse(String(e.data)) as Frame;
      } catch {
        return;
      }
      if (f.event === 'subscribed') {
        const rtt = received - sentAt;
        const upstream = f.websocketPublishTimestamp
          ? Date.parse(f.websocketPublishTimestamp)
          : NaN;
        skewMs = Number.isFinite(upstream) ? upstream - (sentAt + rtt / 2) : 0;
        line(
          `subscribed (+${received - t0} ms): RTT ${rtt} ms, DraftKings clock ${skewMs >= 0 ? '+' : ''}${Math.round(skewMs)} ms vs this machine\n`,
        );
        return;
      }
      if (f.event !== 'update') return;
      const created = Date.parse(f.data?.metadata?.createdTime ?? '');
      const published = Date.parse(f.websocketPublishTimestamp ?? '');
      if (!Number.isFinite(created) || !Number.isFinite(published)) return;
      const ins = Math.round(published - created);
      const net = Math.round(received - (published - skewMs));
      inside.push(ins);
      network.push(net);
      total.push(Math.round(received - (created - skewMs)));
      if (inside.length <= 5)
        line(`  update #${inside.length}: inside DraftKings ${ins} ms + network ${net} ms`);
    };

    ws.onerror = () => line('socket error');
    setTimeout(() => {
      ws.close();
      if (inside.length === 0) {
        line(
          '\nNo updates in the window — nothing moved in this league. Try one with games in play.',
        );
      } else {
        const neg = network.filter((n) => n < 0).length;
        line(`\n${inside.length} updates. All values in milliseconds:`);
        row('inside DraftKings', inside);
        row('network to us', network);
        row('engine -> us', total);
        line(
          `\nself-check: ${neg} of ${network.length} network samples negative ${neg === 0 ? '(skew sound)' : '(skew off)'}`,
        );
        line(
          'The "inside DraftKings" leg is their two timestamps; the app adds only the network leg plus < 1 ms.',
        );
      }
      resolve();
    }, DURATION_MS);
  });
}

/* ------------------------------------------------------------------ run */

async function main(): Promise<void> {
  line(
    `Betstamp take-home demo — league ${config.dk.leagueName || config.dk.leagueId} (${config.dk.leagueId}/${config.dk.subcategoryId}), site ${config.dk.site}`,
  );
  await actWhyNode();
  await pause();
  const feed = await actDeriveFeed();
  await pause();
  await actLatency(feed);
  line('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
