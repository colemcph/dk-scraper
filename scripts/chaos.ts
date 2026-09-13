/**
 * End-to-end resilience run against a mock DraftKings.
 *
 *   npm run build && npm run chaos
 *
 * Starts a fake snapshot API + fake socket on localhost, points the REAL built server at them
 * (DK_REST_BASE_URL / DK_WS_URL), then walks through the failure modes the brief asks about and
 * prints what /healthz and /api/odds reported at each step:
 *
 *   1. healthy: snapshot + socket subscribe + a pushed price change
 *   2. socket killed and kept down          -> RECONNECTING, then POLLING
 *   3. snapshot API returns HTML garbage    -> DEGRADED, last-known-good odds still served
 *   4. snapshot API returns HTTP 500        -> still DEGRADED, still serving, then STALE
 *   5. snapshot API recovers with a moved line -> POLLING, change applied from the snapshot
 *   6. socket comes back                    -> LIVE again (within the 15 s reconnect backoff cap)
 *
 * Nothing here touches draftkings.com.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';

const REST_PORT = 4801;
const WS_PORT = 4802;
const APP_PORT = 4800;

type RestMode = 'ok' | 'garbage' | 'error';
let restMode: RestMode = 'ok';

const fixture = JSON.parse(readFileSync(resolve('fixtures/dk-league-88808.json'), 'utf8')) as {
  selections: Array<{
    id: string;
    trueOdds?: number;
    displayOdds?: { american?: string; decimal?: string };
  }>;
};
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
async function report(step: string): Promise<void> {
  const h = await app('/healthz');
  const o = (await app('/api/odds')) as {
    games?: Array<{
      id: string;
      markets: { moneyline?: { sides?: { home?: { odds: { american: number } } } } };
    }>;
    meta?: { lastError?: { message: string } | null };
  };
  const det = o.games?.find((g) => g.id === '34118210');
  const price = det?.markets.moneyline?.sides?.home?.odds.american;
  console.log(
    `${step.padEnd(52)} state=${String(h.feedState).padEnd(12)} stale=${String(h.stale).padEnd(5)} games=${String(o.games?.length ?? 0).padEnd(3)} DET ML=${String(price ?? '—').padEnd(5)} lastError=${o.meta?.lastError?.message?.slice(0, 40) ?? '-'}`,
  );
}

async function main(): Promise<void> {
  await new Promise<void>((r) => rest.listen(REST_PORT, r));
  startSocket();

  const child: ChildProcess = spawn(process.execPath, ['dist/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      LOG_LEVEL: 'warn',
      DK_REST_BASE_URL: `http://127.0.0.1:${REST_PORT}`,
      DK_WS_URL: `ws://127.0.0.1:${WS_PORT}/websocket`,
      RESYNC_INTERVAL_MS: '4000',
      POLL_INTERVAL_MS: '1000',
      WS_FALLBACK_AFTER_MS: '3000',
      STALE_AFTER_MS: '6000',
      REFRESH_MIN_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    console.log(`fixture DET Lions ML = ${target.displayOdds?.american}\n`);
    await sleep(1200);
    await report('1a boot: snapshot from mock');
    await sleep(2500);
    await report('1b socket pushed DET ML -> -300');

    await stopSocket();
    await sleep(1500);
    await report('2a socket killed');
    await sleep(3500);
    await report('2b socket still down (> fallback window)');

    restMode = 'garbage';
    await sleep(3000);
    await report('3  snapshot API returns HTML');

    restMode = 'error';
    await sleep(3000);
    await report('4a snapshot API returns HTTP 500');
    await sleep(5000);
    await report('4b ... 8 s with no contact at all');

    restMode = 'ok';
    currentSel.trueOdds = 1.2857;
    currentSel.displayOdds = { american: '−350', decimal: '1.29' };
    await sleep(2500);
    await report('5  snapshot API back, DET ML now -350');

    startSocket();
    await sleep(17000);
    await report('6  socket back (reconnect backoff is capped at 15 s)');
  } finally {
    child.kill();
    await stopSocket();
    rest.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
