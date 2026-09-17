import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/api.js';
import type { FeedManager } from '../src/server/feed.js';
import { silentLogger } from '../src/server/logger.js';
import type { MoveLog } from '../src/server/moves.js';
import { SseHub } from '../src/server/sse.js';
import type { AppConfig } from '../src/server/config.js';
import type { BookMove } from '../src/shared/compare.js';
import type { BookId, FeedMeta, Game, OddsBundle, OddsSnapshot } from '../src/shared/types.js';
import { game } from './helpers.js';

/** A FeedManager stand-in: fixed snapshot, refresh honours the rate limit contract. */
function fakeFeed(book: BookId = 'draftkings', games: Game[] = [game('g1', { book })]) {
  const meta = (): FeedMeta =>
    ({
      book,
      bookName: book === 'draftkings' ? 'DraftKings' : 'FanDuel',
      transport: book === 'draftkings' ? 'push' : 'poll',
      league: book === 'draftkings' ? '88808' : 'nfl',
      leagueName: 'NFL',
      site: book === 'draftkings' ? 'dkcaon' : 'on',
      feedState: book === 'draftkings' ? 'live' : 'polling',
      stale: false,
      lastContactAt: new Date().toISOString(),
      lastChangeAt: null,
      lastSnapshotAt: new Date().toISOString(),
      socketConnectedAt: null,
      lastError: null,
      serverTime: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      version: 1,
      latency: { samples: 0, p50Ms: null, p95Ms: null, lastMs: null },
      counters: { socketUpdates: 0, socketReconnects: 0, restSnapshots: 1, restFailures: 0 },
      poll: null,
    }) as unknown as FeedMeta;
  let refreshes = 0;
  return {
    book,
    on: () => () => {},
    snapshot: (): OddsSnapshot => ({ version: 1, games, meta: meta() }),
    meta,
    refresh: async () => {
      refreshes++;
      return refreshes === 1
        ? { ok: true, changes: 0, meta: meta() }
        : { ok: false, retryAfterMs: 4200, changes: 0, meta: meta() };
    },
  } as unknown as FeedManager;
}

const noMoves = { list: () => [] } as unknown as MoveLog;

const config = {
  dk: {
    site: 'dkcaon',
    wsRegion: 'ca-on',
    leagueId: '88808',
    leagueName: 'NFL',
    subcategoryId: '4518',
  },
  fd: {
    enabled: true,
    region: 'on',
    pageId: 'nfl',
    leagueName: 'NFL',
    apiKey: 'k',
    timezone: 'America/Toronto',
    pollIntervalMs: 1_000,
    bypassCache: false,
  },
  feed: {
    resyncIntervalMs: 60_000,
    pollIntervalMs: 3_000,
    wsFallbackAfterMs: 15_000,
    staleAfterMs: 90_000,
    refreshMinIntervalMs: 5_000,
  },
} as AppConfig;

describe('HTTP API', () => {
  let hub: SseHub;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const feed = fakeFeed();
    hub = new SseHub({ feeds: [feed], logger: silentLogger, heartbeatIntervalMs: 60_000 });
    hub.start();
    app = createApp({ feeds: [feed], hub, moves: noMoves, config, logger: silentLogger });
  });
  afterEach(() => hub.stop());

  it('serves every book`s normalized snapshot with no-store caching, and one book by name', async () => {
    const res = await app.request('/api/odds');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as OddsBundle;
    expect(Object.keys(body.books)).toEqual(['draftkings']);
    const dk = body.books.draftkings!;
    expect(dk.games[0]!.markets.moneyline!.sides.home!.odds.american).toBe(-170);
    expect(dk.meta.feedState).toBe('live');

    const one = await app.request('/api/odds/draftkings');
    expect(((await one.json()) as OddsSnapshot).meta.book).toBe('draftkings');
    expect((await app.request('/api/odds/pinnacle')).status).toBe(404);
  });

  it('answers the health check per book and the time endpoint', async () => {
    const health = (await (await app.request('/healthz')).json()) as {
      ok: boolean;
      books: Record<string, { feedState: string }>;
    };
    expect(health.ok).toBe(true);
    expect(health.books.draftkings).toMatchObject({ feedState: 'live' });
    const time = (await (await app.request('/api/time')).json()) as { serverTimeMs: number };
    expect(Math.abs(time.serverTimeMs - Date.now())).toBeLessThan(2_000);
  });

  it('rate-limits the Refresh button with a 429 and Retry-After', async () => {
    const first = await app.request('/api/refresh', { method: 'POST' });
    expect(first.status).toBe(200);
    expect((await first.json()) as unknown).toMatchObject({
      ok: true,
      books: { draftkings: { ok: true, changes: 0 } },
    });
    const second = await app.request('/api/refresh', { method: 'POST' });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('5');
    expect(((await second.json()) as { retryAfterMs: number }).retryAfterMs).toBe(4200);
    expect((await app.request('/api/refresh?book=nope', { method: 'POST' })).status).toBe(404);
  });

  it('opens an SSE stream that starts with a snapshot event', async () => {
    const res = await app.request('/api/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: snapshot');
    expect(text).toContain('id: 0');
    expect(text).toContain('"leagueName":"NFL"');
    expect(hub.clientCount).toBe(1);
    await reader.cancel();
  });

  it('exposes diagnostics and metrics per book without leaking anything but config and counters', async () => {
    const body = (await (await app.request('/api/diagnostics')).json()) as {
      books: Record<string, { book: string }>;
      config: { dk: { site: string }; fd: { region: string; bypassCache: boolean } };
      process: { node: string };
      sseClients: number;
    };
    expect(body.books.draftkings!.book).toBe('draftkings');
    expect(body.config.dk.site).toBe('dkcaon');
    expect(body.config.fd).toMatchObject({ region: 'on', bypassCache: false });
    expect(body.process.node).toBe(process.version);
    expect(body.sseClients).toBe(0);

    const metrics = (await (await app.request('/api/metrics')).json()) as {
      books: Record<string, { transport: string }>;
    };
    expect(metrics.books.draftkings!.transport).toBe('push');
  });

  it('never turns an unexpected handler error into a crash', async () => {
    const broken = createApp({
      feeds: [
        {
          ...fakeFeed(),
          snapshot: () => {
            throw new Error('boom');
          },
        } as unknown as FeedManager,
      ],
      hub,
      moves: noMoves,
      config,
      logger: silentLogger,
    });
    const res = await broken.request('/api/odds');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
  });
});

describe('HTTP API with two books', () => {
  const dkGame = game('dk1', { book: 'draftkings' });
  dkGame.home = { id: '18348', name: 'DET Lions', shortName: 'DET' };
  dkGame.away = { id: '18423', name: 'NO Saints', shortName: 'NO' };
  const fdGame = game('fd1', {
    book: 'fanduel',
    startTime: new Date(Date.parse(dkGame.startTime) + 60_000).toISOString(),
  });
  fdGame.home = { id: 'DET', name: 'Detroit Lions', shortName: 'DET' };
  fdGame.away = { id: 'NO', name: 'New Orleans Saints', shortName: 'NO' };
  fdGame.markets.moneyline!.sides.home!.odds = { american: -165, decimal: 1.606 }; // better than DK's -170
  const t0 = Date.now() - 60_000;
  const moves: BookMove[] = [
    {
      book: 'draftkings',
      gameId: 'dk1',
      market: 'spread',
      side: 'home',
      field: 'line',
      prevLine: -3.5,
      nextLine: -4,
      prevOdds: { american: -110, decimal: 1.909 },
      nextOdds: { american: -110, decimal: 1.909 },
      at: new Date(t0).toISOString(),
      source: 'socket',
    },
    {
      book: 'fanduel',
      gameId: 'fd1',
      market: 'spread',
      side: 'home',
      field: 'line',
      prevLine: -3.5,
      nextLine: -4,
      prevOdds: { american: -110, decimal: 1.909 },
      nextOdds: { american: -110, decimal: 1.909 },
      at: new Date(t0 + 25_000).toISOString(),
      source: 'snapshot',
    },
  ];
  let hub: SseHub;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const feeds = [fakeFeed('draftkings', [dkGame]), fakeFeed('fanduel', [fdGame])];
    hub = new SseHub({ feeds, logger: silentLogger, heartbeatIntervalMs: 60_000 });
    hub.start();
    app = createApp({
      feeds,
      hub,
      moves: { list: () => moves } as unknown as MoveLog,
      config,
      logger: silentLogger,
    });
  });
  afterEach(() => hub.stop());

  it('bundles both snapshots and streams a snapshot per book', async () => {
    const body = (await (await app.request('/api/odds')).json()) as OddsBundle;
    expect(Object.keys(body.books)).toEqual(['draftkings', 'fanduel']);
    const res = await app.request('/api/stream');
    // Each SSE message is its own chunk: keep reading until both snapshots have arrived.
    const reader = res.body!.getReader();
    let text = '';
    while ((text.match(/event: snapshot/g) ?? []).length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text.match(/event: snapshot/g)).toHaveLength(2);
    expect(text).toContain('"book":"fanduel"');
    await reader.cancel();
  });

  it('matches the same game across books and says who moved first', async () => {
    const body = (await (await app.request('/api/compare')).json()) as {
      books: string[];
      pairs: Array<{
        key: string;
        resolved: boolean;
        gameIds: Record<string, string>;
        markets: { moneyline: { sides: Array<{ side: string; best: string | null }> } };
      }>;
      moves: {
        paired: Array<{ leadMs: number; first: { book: string } }>;
        leads: Record<string, number>;
      };
    };
    expect(body.books).toEqual(['draftkings', 'fanduel']);
    expect(body.pairs).toHaveLength(1);
    expect(body.pairs[0]).toMatchObject({
      key: 'NO@DET',
      resolved: true,
      gameIds: { draftkings: 'dk1', fanduel: 'fd1' },
    });
    const home = body.pairs[0]!.markets.moneyline.sides.find((s) => s.side === 'home')!;
    expect(home.best).toBe('fanduel');
    expect(body.moves.paired).toHaveLength(1);
    expect(body.moves.paired[0]).toMatchObject({ leadMs: 25_000, first: { book: 'draftkings' } });
    expect(body.moves.leads).toEqual({ draftkings: 1, fanduel: 0 });
  });

  it('refreshes every book, and only reports 429 when all of them are rate-limited', async () => {
    const first = await app.request('/api/refresh', { method: 'POST' });
    expect(first.status).toBe(200);
    const one = await app.request('/api/refresh?book=fanduel', { method: 'POST' });
    expect(one.status).toBe(429); // FanDuel already refreshed a moment ago
    const both = await app.request('/api/refresh', { method: 'POST' });
    expect(both.status).toBe(429);
    expect(Object.keys(((await both.json()) as { books: object }).books)).toEqual([
      'draftkings',
      'fanduel',
    ]);
  });
});
