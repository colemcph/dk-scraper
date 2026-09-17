/**
 * Live latency decomposition against the real DraftKings socket.
 *
 *   npm run latency                      # NFL (quiet outside game windows)
 *   DK_LEAGUE_ID=84240 DK_SUBCATEGORY_ID=4519 npm run latency   # MLB (in play most evenings)
 *
 * Subscribes for ~45 s and, for every update frame, separates the three legs using the
 * timestamps DraftKings itself puts on the frame:
 *
 *   inside DraftKings : createdTime -> websocketPublishTimestamp   (their clocks only, no skew)
 *   network           : websocketPublishTimestamp -> our receipt   (skew-corrected)
 *   total             : createdTime -> our receipt                 (what the app reports)
 *
 * Skew is estimated NTP-style from the subscribe ack. The self-check is the network leg: if the
 * skew estimate is right it is small and never negative.
 */
import { DK_LEAGUES, DraftKingsAdapter } from '../src/server/draftkings/adapter.js';
import { loadConfig } from '../src/server/config.js';
import { createLogger } from '../src/server/logger.js';

const DURATION_MS = Number(process.env.DURATION_MS ?? 45_000);
const config = loadConfig();
const known = Object.values(DK_LEAGUES).find((l) => l.id === config.dk.leagueId);
const league = {
  id: config.dk.leagueId,
  name: config.dk.leagueName || known?.name || config.dk.leagueId,
  subcategoryId: config.dk.subcategoryId,
};
const adapter = new DraftKingsAdapter({
  site: config.dk.site,
  wsRegion: config.dk.wsRegion,
  logger: createLogger('warn', 'latency'),
});

let skewMs: number | null = null;
const samples: { inside: number; network: number; total: number }[] = [];
const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
};
const row = (label: string, values: number[]) =>
  console.log(
    `  ${label.padEnd(20)} min ${String(Math.min(...values)).padStart(5)} ms   p50 ${String(pct(values, 0.5)).padStart(5)} ms   p95 ${String(pct(values, 0.95)).padStart(5)} ms   max ${String(Math.max(...values)).padStart(5)} ms`,
  );

console.log(
  `Subscribing to ${league.name} (${league.id}/${league.subcategoryId}) on ${config.dk.site} for ${DURATION_MS / 1000} s...`,
);
const sub = adapter.subscribe(league, undefined, {
  onAck: ({ rttMs, skewMs: s }) => {
    skewMs = s;
    console.log(
      `subscribed: RTT ${rttMs} ms, DraftKings clock is ${s >= 0 ? '+' : ''}${Math.round(s)} ms relative to this machine (uncertainty ±${Math.round(rttMs / 2)} ms)\n`,
    );
  },
  onDelta: (d) => {
    const created = Date.parse(d.createdAt);
    const published = Date.parse(d.publishedAt);
    const received = Date.parse(d.receivedAt);
    const skew = skewMs ?? 0;
    const sample = {
      inside: Math.round(published - created),
      network: Math.round(received - (published - skew)),
      total: Math.round(received - (created - skew)),
    };
    samples.push(sample);
    if (samples.length <= 5) {
      console.log(
        `  update #${samples.length}: inside DraftKings ${sample.inside} ms + network ${sample.network} ms = ${sample.total} ms`,
      );
    }
  },
  onState: () => {},
  onActivity: () => {},
  onError: (err) => console.log('error:', err.message),
});

setTimeout(() => {
  sub.close();
  if (samples.length === 0) {
    console.log(
      '\nNo updates arrived — nothing moved in this league during the window. Try a league with games in play.',
    );
    process.exit(0);
  }
  const negative = samples.filter((s) => s.network < 0).length;
  console.log(
    `\n${samples.length} updates in ${DURATION_MS / 1000} s. All values in milliseconds:`,
  );
  row(
    'inside DraftKings',
    samples.map((s) => s.inside),
  );
  row(
    'network to us',
    samples.map((s) => s.network),
  );
  row(
    'engine -> us',
    samples.map((s) => s.total),
  );
  console.log(
    `\nself-check: ${negative} of ${samples.length} network samples negative ${negative === 0 ? '(skew estimate is sound)' : '(skew estimate is off)'}`,
  );
  console.log(
    'The "inside DraftKings" leg uses only their two timestamps; the app adds nothing to it. Our share is the network leg plus < 1 ms of processing.',
  );
  process.exit(0);
}, DURATION_MS);
