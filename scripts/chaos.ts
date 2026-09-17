/**
 * End-to-end resilience run against a mock DraftKings and a mock FanDuel.
 *
 *   npm run build && npm run chaos
 *
 * Starts a fake DraftKings snapshot API + socket and a fake FanDuel page API on localhost, points
 * the REAL built server at them (DK_REST_BASE_URL / DK_WS_URL / FD_REST_BASE_URL), then walks
 * through the failure modes the brief asks about and prints what /healthz and /api/odds reported
 * at each step:
 *
 *   1. healthy: DK snapshot + socket subscribe + a pushed price change; FanDuel polled with ETags
 *   2. DK socket killed and kept down          -> RECONNECTING, then POLLING (FanDuel unaffected)
 *   3. DK snapshot API returns HTML garbage    -> DEGRADED, last-known-good odds still served
 *   4. DK snapshot API returns HTTP 500        -> still DEGRADED, still serving, then STALE
 *   5. DK snapshot API recovers with a moved line -> POLLING, change applied from the snapshot
 *      FanDuel moves a price behind its cache  -> picked up by the next poll (200 after 304s)
 *      FanDuel API returns 500 / recovers      -> FanDuel DEGRADED then POLLING; DraftKings untouched
 *      (recovery is not instant: repeated failures back the polling off, capped at 8 s)
 *   6. DK socket comes back                    -> LIVE again (within the 15 s reconnect backoff cap)
 *
 * Nothing here touches draftkings.com or fanduel.ca.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';

const REST_PORT = 4801;
const WS_PORT = 4802;
const FD_PORT = 4803;
const APP_PORT = 4800;

type RestMode = 'ok' | 'garbage' | 'error';
let restMode: RestMode = 'ok';
let fdMode: 'ok' | 'error' = 'ok';

/* ------------------------------------------------------------------------------ mock DraftKings */

const fixture = JSON.parse(readFileSync(resolve('fixtures/dk-league-88808.json'), 'utf8')) as {
  events: Array<{ startEventDate: string }>;
  selections: Array<{
    id: string;
    trueOdds?: number;
    displayOdds?: { american?: string; decimal?: string };
  }>;
};
// The fixture was captured in September 2026; shift every kickoff so the earliest is tomorrow,
// otherwise the store's "kicked off hours ago" guard hides games and the run stops being reproducible.
{
  const earliest = Math.min(...fixture.events.map((e) => Date.parse(e.startEventDate)));
  const shift = Date.now() + 24 * 60 * 60_000 - earliest;
  for (const e of fixture.events) {
    e.startEventDate = new Date(Date.parse(e.startEventDate) + shift).toISOString();
  }
}
const TARGET_SEL = '0ML84695643_1'; // DET Lions moneyline, -325 in the fixture
const target = fixture.selections.find((s) => s.id === TARGET_SEL)!;

/** What the mock REST API currently believes; the socket push below updates it too, like the real thing. */
const current = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
const currentSel = current.selections.find((s) => s.id === TARGET_SEL)!;

const rest: Server = createServer((req, res) => {
  if (restMode === 'garbage') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>Access Denied</body></html>');
    return;
  }
  if (restMode === 'error') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"upstream exploded"}');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public,max-age=1' });
  res.end(JSON.stringify(current));
  void req;
});

let wss: WebSocketServer | null = null;
let pushedOnce = false;
function startSocket(): void {
  wss = new WebSocketServer({ port: WS_PORT, path: '/websocket' });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id: string; method: string };
      if (msg.method !== 'subscribe') return;
      const now = new Date().toISOString();
      socket.send(
        JSON.stringify({
          id: msg.id,
          event: 'subscribed',
          data: '',
          websocketPublishTimestamp: now,
        }),
      );
      setTimeout(() => {
        const t = new Date().toISOString();
        // First subscribe: DraftKings moves DET to -300. Later subscribes just re-push the current price.
        if (!pushedOnce) {
          pushedOnce = true;
          currentSel.trueOdds = 1.3333;
          currentSel.displayOdds = { american: '−300', decimal: '1.33' };
        }
        socket.send(
          JSON.stringify({
            id: msg.id,
            event: 'update',
            data: {
              data: {
                add: { events: [], markets: [], selections: [] },
                remove: { events: [], markets: [], selections: [] },
                change: {
                  events: [],
                  markets: [],
                  selections: [
                    {
                      id: TARGET_SEL,
                      label: 'DET Lions',
                      trueOdds: currentSel.trueOdds,
                      displayOdds: currentSel.displayOdds,
                    },
                  ],
                },
              },
              metadata: { createdTime: t, receivedTime: t, publishedTime: t },
            },
            websocketPublishTimestamp: t,
          }),
        );
      }, 1500);
    });
  });
}
function stopSocket(): Promise<void> {
  return new Promise((done) => {
    if (!wss) return done();
    for (const c of wss.clients) c.terminate();
    wss.close(() => {
      wss = null;
      done();
    });
  });
}

/* --------------------------------------------------------------------------------- mock FanDuel */

interface FdPage {
  attachments: {
    events: Record<string, { eventId: number; openDate: string }>;
    markets: Record<
      string,
      {
        marketTime: string;
        runners: Array<{
          winRunnerOdds: {
            americanDisplayOdds: { americanOdds: number };
            trueOdds: { decimalOdds: { decimalOdds: number } };
          };
        }>;
      }
    >;
  };
}
const fdCurrent = JSON.parse(readFileSync(resolve('fixtures/fd-page-nfl.json'), 'utf8')) as FdPage;
{
  const events = Object.values(fdCurrent.attachments.events);
  const earliest = Math.min(...events.map((e) => Date.parse(e.openDate)));
  const shift = Date.now() + 24 * 60 * 60_000 - earliest;
  for (const e of events) e.openDate = new Date(Date.parse(e.openDate) + shift).toISOString();
  for (const m of Object.values(fdCurrent.attachments.markets)) {
    m.marketTime = new Date(Date.parse(m.marketTime) + shift).toISOString();
  }
}
const FD_GAME = '35599552'; // Detroit Lions @ Buffalo Bills
const FD_TARGET_MARKET = '801.168781244'; // its moneyline; runners[0] = DET (away), +205 in the fixture
const fdTarget = fdCurrent.attachments.markets[FD_TARGET_MARKET]!.runners[0]!;

/** The mock behaves like the CDN in front of the real API: max-age, Age, ETag, 304s. */
const FD_MAX_AGE_S = 2;
let fdBody = '';
let fdEtag = '';
let fdCopyAt = 0;
function fdPublish(): void {
  fdBody = JSON.stringify(fdCurrent);
  fdEtag = `W/"${createHash('sha1').update(fdBody).digest('hex').slice(0, 12)}"`;
  fdCopyAt = Date.now();
}
fdPublish();

const fdRest: Server = createServer((req, res) => {
  if (fdMode === 'error') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":true}');
    return;
  }
  if (Date.now() - fdCopyAt >= FD_MAX_AGE_S * 1000) fdCopyAt = Date.now(); // edge copy turns over
  const age = Math.floor((Date.now() - fdCopyAt) / 1000);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${FD_MAX_AGE_S}, stale-while-revalidate=4`,
    etag: fdEtag,
    age: String(age),
    date: new Date().toUTCString(),
    'x-cache': age === 0 ? 'Miss from cloudfront' : 'Hit from cloudfront',
  };
  if (req.headers['if-none-match'] === fdEtag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(fdBody);
});

/* ------------------------------------------------------------------------------------- the run */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function app(path: string): Promise<Record<string, unknown>> {
  try {
    return (await (await fetch(`http://127.0.0.1:${APP_PORT}${path}`)).json()) as Record<
      string,
      unknown
    >;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

interface BookHealth {
  feedState: string;
  stale: boolean;
}
interface BookOdds {
  games?: Array<{
    id: string;
    markets: {
      moneyline?: {
        sides?: { home?: { odds: { american: number } }; away?: { odds: { american: number } } };
      };
    };
  }>;
  meta?: { lastError?: { message: string } | null; counters?: { restNotModified?: number } };
}

async function report(step: string): Promise<void> {
  const h = (await app('/healthz')) as { books?: Record<string, BookHealth> };
  const o = (await app('/api/odds')) as { books?: Record<string, BookOdds> };
  const dk = o.books?.draftkings;
  const fd = o.books?.fanduel;
  const dkDet = dk?.games?.find((g) => g.id === '34118210')?.markets.moneyline?.sides?.home?.odds
    .american;
  const fdDet = fd?.games?.find((g) => g.id === FD_GAME)?.markets.moneyline?.sides?.away?.odds
    .american;
  const st = (b: string) => {
    const x = h.books?.[b];
    return x ? `${x.feedState}${x.stale ? '/STALE' : ''}` : '—';
  };
  // The most recent upstream error across both books, so a FanDuel outage reads as one.
  const errs = [dk?.meta?.lastError, fd?.meta?.lastError]
    .map((e, i) => (e ? { book: i === 0 ? 'DK' : 'FD', ...e } : null))
    .filter((e): e is { book: string; at: string; message: string } => e !== null)
    .sort((a, b) => b.at.localeCompare(a.at));
  const err = errs[0] ? `lastError(${errs[0].book})=${errs[0].message.slice(0, 34)}` : '';
  console.log(
    `${step.padEnd(50)} DK=${st('draftkings').padEnd(13)} FD=${st('fanduel').padEnd(15)} games=${String(dk?.games?.length ?? 0).padStart(2)}/${String(fd?.games?.length ?? 0).padEnd(2)} DET ML DK=${String(dkDet ?? '—').padEnd(5)} FD=${String(fdDet ?? '—').padEnd(5)} 304s=${String(fd?.meta?.counters?.restNotModified ?? 0).padEnd(3)} ${err}`.trimEnd(),
  );
}

async function main(): Promise<void> {
  await new Promise<void>((r) => rest.listen(REST_PORT, r));
  await new Promise<void>((r) => fdRest.listen(FD_PORT, r));
  startSocket();

  const child: ChildProcess = spawn(process.execPath, ['dist/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      LOG_LEVEL: 'warn',
      DK_REST_BASE_URL: `http://127.0.0.1:${REST_PORT}`,
      DK_WS_URL: `ws://127.0.0.1:${WS_PORT}/websocket`,
      FD_ENABLED: 'true',
      FD_REST_BASE_URL: `http://127.0.0.1:${FD_PORT}`,
      FD_POLL_INTERVAL_MS: '500',
      RESYNC_INTERVAL_MS: '4000',
      POLL_INTERVAL_MS: '1000',
      WS_FALLBACK_AFTER_MS: '3000',
      STALE_AFTER_MS: '6000',
      REFRESH_MIN_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    console.log(
      `fixtures: DraftKings DET Lions ML = ${target.displayOdds?.american}, FanDuel DET Lions ML = +${fdTarget.winRunnerOdds.americanDisplayOdds.americanOdds}\n`,
    );
    await sleep(1200);
    await report('1a boot: snapshots from both mocks');
    await sleep(2500);
    await report('1b DK socket pushed DET ML -> -300; FD polling');

    await stopSocket();
    await sleep(1500);
    await report('2a DK socket killed');
    await sleep(3500);
    await report('2b DK socket still down (> fallback window)');

    restMode = 'garbage';
    await sleep(3000);
    await report('3  DK snapshot API returns HTML');

    restMode = 'error';
    await sleep(3000);
    await report('4a DK snapshot API returns HTTP 500');
    await sleep(5000);
    await report('4b ... 8 s with no DK contact at all');

    restMode = 'ok';
    currentSel.trueOdds = 1.2857;
    currentSel.displayOdds = { american: '−350', decimal: '1.29' };
    // Long enough for the poll backoff (capped at 8 s after repeated failures) to try again.
    await sleep(10000);
    await report('5a DK snapshot API back, DET ML now -350');

    fdTarget.winRunnerOdds.americanDisplayOdds.americanOdds = 220;
    fdTarget.winRunnerOdds.trueOdds.decimalOdds.decimalOdds = 3.2;
    fdPublish();
    await sleep(3500);
    await report('5b FD moved DET ML +205 -> +220 behind its cache');

    fdMode = 'error';
    await sleep(3500);
    await report('5c FD API returns HTTP 500 (DK untouched)');

    fdMode = 'ok';
    await sleep(9000);
    await report('5d FD API back');

    startSocket();
    await sleep(17000);
    await report('6  DK socket back (reconnect backoff capped at 15 s)');
  } finally {
    child.kill();
    await stopSocket();
    rest.close();
    fdRest.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
