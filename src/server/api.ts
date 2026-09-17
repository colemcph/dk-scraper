import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { compareMarket, matchGames, pairKeyOf, pairMoves } from '../shared/compare.js';
import type { BookId, FeedMeta, OddsBundle, OddsSnapshot } from '../shared/types.js';
import type { AppConfig } from './config.js';
import type { FeedManager } from './feed.js';
import type { Logger } from './logger.js';
import type { MoveLog } from './moves.js';
import type { SseHub } from './sse.js';

export interface AppDeps {
  /** One per book. */
  feeds: FeedManager[];
  hub: SseHub;
  moves: MoveLog;
  config: AppConfig;
  logger: Logger;
  /** Directory with the built React app; omitted in dev (Vite serves it). */
  staticRoot?: string;
  version?: string;
}

/** How far apart two books' versions of the same move may be and still count as one move. */
const MOVE_PAIR_WINDOW_MS = 120_000;

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const startedAt = Date.now();
  const feedByBook = new Map<string, FeedManager>(deps.feeds.map((f) => [f.book, f]));
  const perBook = <T>(pick: (meta: FeedMeta) => T): Partial<Record<BookId, T>> => {
    const out: Partial<Record<BookId, T>> = {};
    for (const feed of deps.feeds) out[feed.book] = pick(feed.meta());
    return out;
  };

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  /** Full normalized state for every book. */
  app.get('/api/odds', (c) => {
    const books: Partial<Record<BookId, OddsSnapshot>> = {};
    for (const feed of deps.feeds) books[feed.book] = feed.snapshot();
    const bundle: OddsBundle = { serverTime: new Date().toISOString(), books };
    return c.json(bundle);
  });

  /** One book's snapshot: `{ version, games[], meta }`. */
  app.get('/api/odds/:book', (c) => {
    const feed = feedByBook.get(c.req.param('book'));
    if (!feed) return c.json({ error: 'unknown book' }, 404);
    return c.json(feed.snapshot());
  });

  /**
   * The same game at every book, side by side, plus which book showed each recent move first.
   * Pure functions from `src/shared/compare.ts` over the same state the browsers hold.
   */
  app.get('/api/compare', (c) => {
    const games = deps.feeds.flatMap((f) => f.snapshot().games);
    const pairs = matchGames(games);
    const keyByGame = new Map(games.map((g) => [`${g.book}:${g.id}`, pairKeyOf(g).key]));
    const pairing = pairMoves(
      deps.moves.list(),
      (m) => keyByGame.get(`${m.book}:${m.gameId}`),
      MOVE_PAIR_WINDOW_MS,
    );
    return c.json({
      serverTime: new Date().toISOString(),
      books: deps.feeds.map((f) => f.book),
      pairs: pairs.map((p) => ({
        key: p.key,
        resolved: p.resolved,
        startTime: p.startTime,
        status: p.status,
        away: p.away,
        home: p.home,
        gameIds: Object.fromEntries(
          (Object.entries(p.games) as [BookId, { id: string }][]).map(([b, g]) => [b, g.id]),
        ),
        markets: {
          moneyline: compareMarket(p, 'moneyline'),
          spread: compareMarket(p, 'spread'),
          total: compareMarket(p, 'total'),
        },
      })),
      moves: { windowMs: MOVE_PAIR_WINDOW_MS, ...pairing },
    });
  });

  /** Live stream: snapshot per book -> delta* with heartbeats. Plain EventSource on the client. */
  app.get('/api/stream', (c) => {
    const lastEventId = c.req.header('Last-Event-ID') ?? c.req.query('lastEventId');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const client = deps.hub.add({ write: (m) => stream.writeSSE(m) }, lastEventId);
      stream.onAbort(() => deps.hub.remove(client.id));
      await client.closed;
    });
  });

  /**
   * Manual refresh: forces a snapshot resync of every book (or `?book=`). Each feed rate-limits
   * itself so a crowd can't hammer the books; 429 only when every requested feed refused.
   */
  app.post('/api/refresh', async (c) => {
    const which = c.req.query('book');
    const targets = which ? deps.feeds.filter((f) => f.book === which) : deps.feeds;
    if (targets.length === 0) return c.json({ error: 'unknown book' }, 404);
    const results = await Promise.all(
      targets.map(async (f) => [f.book, await f.refresh()] as const),
    );
    const books: Partial<
      Record<
        BookId,
        { ok: boolean; changes: number; retryAfterMs?: number; feedState: string; stale: boolean }
      >
    > = {};
    let anyOk = false;
    let allRateLimited = true;
    let retryAfterMs = Infinity;
    for (const [book, r] of results) {
      books[book] = {
        ok: r.ok,
        changes: r.changes,
        ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}),
        feedState: r.meta.feedState,
        stale: r.meta.stale,
      };
      if (r.ok) anyOk = true;
      if (r.retryAfterMs === undefined) allRateLimited = false;
      else retryAfterMs = Math.min(retryAfterMs, r.retryAfterMs);
    }
    if (allRateLimited) {
      c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return c.json({ ok: false, retryAfterMs, books }, 429);
    }
    return c.json({ ok: anyOk, books }, anyOk ? 200 : 502);
  });

  /** For the browser's NTP-style clock offset estimate. */
  app.get('/api/time', (c) =>
    c.json({ serverTime: new Date().toISOString(), serverTimeMs: Date.now() }),
  );

  app.get('/api/metrics', (c) =>
    c.json({
      books: perBook((meta) => ({
        feedState: meta.feedState,
        stale: meta.stale,
        transport: meta.transport,
        latency: meta.latency,
        counters: meta.counters,
        poll: meta.poll,
      })),
      sseClients: deps.hub.clientCount,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      version: deps.version ?? 'dev',
    }),
  );

  /** Everything you'd want when asking "can this host reach the books?" */
  app.get('/api/diagnostics', (c) =>
    c.json({
      books: perBook((meta) => meta),
      config: {
        dk: {
          site: deps.config.dk.site,
          wsRegion: deps.config.dk.wsRegion,
          leagueId: deps.config.dk.leagueId,
          subcategoryId: deps.config.dk.subcategoryId,
        },
        fd: {
          enabled: deps.config.fd.enabled,
          region: deps.config.fd.region,
          pageId: deps.config.fd.pageId,
          pollIntervalMs: deps.config.fd.pollIntervalMs,
          bypassCache: deps.config.fd.bypassCache,
        },
        feed: deps.config.feed,
      },
      process: {
        node: process.version,
        platform: process.platform,
        uptimeSec: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      sseClients: deps.hub.clientCount,
    }),
  );

  /** Process liveness for Render's health check and the keep-alive pinger; per-book state inside. */
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      books: perBook((meta) => ({
        feedState: meta.feedState,
        stale: meta.stale,
        lastContactAt: meta.lastContactAt,
      })),
    }),
  );

  if (deps.staticRoot) {
    app.use('/*', serveStatic({ root: deps.staticRoot }));
    app.get('*', serveStatic({ root: deps.staticRoot, path: 'index.html' }));
  }

  app.onError((err, c) => {
    deps.logger.error('unhandled request error', { path: c.req.path, error: err.message });
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
