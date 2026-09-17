/**
 * Print raw DraftKings socket frames as JSON for a few seconds.
 *
 *   npm run frames                                              # NFL
 *   DK_LEAGUE_ID=84240 DK_SUBCATEGORY_ID=4519 npm run frames    # MLB (in play most evenings)
 *
 * The browser shows these frames as binary because DraftKings' page asks for msgpack; the same
 * server also speaks JSON, which is what this (and the app) requests. Nothing is modified or sent
 * beyond the same subscribe message their own page sends.
 */
import { DK_LEAGUES } from '../src/server/draftkings/adapter.js';
import { defaultSubscriptionSpec } from '../src/server/draftkings/normalize.js';
import { loadConfig } from '../src/server/config.js';

const DURATION_MS = Number(process.env.DURATION_MS ?? 30_000);
const config = loadConfig();
const known = Object.values(DK_LEAGUES).find((l) => l.id === config.dk.leagueId);
const league = {
  id: config.dk.leagueId,
  name: config.dk.leagueName || known?.name || config.dk.leagueId,
  subcategoryId: config.dk.subcategoryId,
};
const spec = defaultSubscriptionSpec(league);
const url =
  config.dk.wsUrl ??
  `wss://sportsbook-ws-${config.dk.wsRegion}.draftkings.com/websocket?format=json&locale=en-US`;

console.log(
  `connecting to ${url}\nsubscribing to ${league.name} (${league.id}/${league.subcategoryId}) as ${config.dk.site}\n`,
);
const ws = new WebSocket(url);
const t0 = Date.now();
let n = 0;

ws.onopen = () => {
  const subscribe = {
    jsonrpc: '2.0',
    method: 'subscribe',
    id: 'demo',
    params: {
      entity: spec.entity,
      queryParams: {
        query: spec.query,
        includeMarkets: spec.includeMarkets,
        initialData: false,
        projection: 'sportsbook',
        locale: 'en-US',
      },
      forwardedHeaders: {},
      clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': 'unknown' },
      jwt: '',
      siteName: config.dk.site,
    },
  };
  console.log(`→ sent (+${Date.now() - t0} ms):\n${JSON.stringify(subscribe, null, 2)}\n`);
  ws.send(JSON.stringify(subscribe));
};

ws.onmessage = (e) => {
  n++;
  const raw = String(e.data);
  let pretty = raw;
  try {
    const f = JSON.parse(raw) as {
      event?: string;
      data?: { data?: Record<string, Record<string, unknown[]>> };
    };
    const d = f.data?.data;
    const counts = d
      ? Object.entries(d)
          .map(
            ([k, v]) =>
              `${k}: ${Object.entries(v)
                .map(([e, a]) => `${e}=${a.length}`)
                .join(' ')}`,
          )
          .join(' | ')
      : '';
    pretty = `${f.event ?? '?'}  ${counts}\n${raw.slice(0, 700)}${raw.length > 700 ? ' …' : ''}`;
  } catch {
    /* print raw */
  }
  console.log(`← frame #${n} (+${Date.now() - t0} ms, ${raw.length} bytes): ${pretty}\n`);
};

ws.onerror = () => console.log('socket error');
ws.onclose = (e) => console.log(`closed code=${e.code} reason=${e.reason}`);

setTimeout(() => {
  ws.close();
  console.log(`${n} frames in ${DURATION_MS / 1000} s`);
  process.exit(0);
}, DURATION_MS);
