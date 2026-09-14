import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppConfig } from './config.js';
import type { FeedManager } from './feed.js';
import type { Logger } from './logger.js';
import type { SseHub } from './sse.js';

export interface AppDeps {
  feed: FeedManager;
  hub: SseHub;
  config: AppConfig;
  logger: Logger;
  /** Directory with the built React app; omitted in dev (Vite serves it). */
  staticRoot?: string;
  version?: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const startedAt = Date.now();

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  /** Full normalized state. Also what the Refresh button re-reads. */
  app.get('/api/odds', (c) => c.json(deps.feed.snapshot()));

  /** Live stream: snapshot -> delta* with heartbeats. Plain EventSource on the client. */
  app.get('/api/stream', (c) => {
    const lastEventId = c.req.header('Last-Event-ID') ?? c.req.query('lastEventId');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const client = deps.hub.add({ write: (m) => stream.writeSSE(m) }, lastEventId);
      stream.onAbort(() => deps.hub.remove(client.id));
      await client.closed;
    });
  });

  /** Manual refresh: forces a snapshot resync (globally rate limited so a crowd can't hammer DraftKings). */
  app.post('/api/refresh', async (c) => {
    const result = await deps.feed.refresh();
    if (!result.ok && result.retryAfterMs !== undefined) {
      c.header('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      return c.json({ ok: false, retryAfterMs: result.retryAfterMs, meta: result.meta }, 429);
    }
    return c.json(result, result.ok ? 200 : 502);
  });

  /** For the browser's NTP-style clock offset estimate. */
  app.get('/api/time', (c) =>
    c.json({ serverTime: new Date().toISOString(), serverTimeMs: Date.now() }),
  );

  app.get('/api/metrics', (c) => {
    const meta = deps.feed.meta();
    return c.json({
      feedState: meta.feedState,
      stale: meta.stale,
      latency: meta.latency,
      counters: meta.counters,
      sseClients: deps.hub.clientCount,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      version: deps.version ?? 'dev',
    });
  });

  /** Everything you'd want when asking "is DraftKings reachable from this host?" */
  app.get('/api/diagnostics', (c) => {
    const meta = deps.feed.meta();
    return c.json({
      meta,
      config: {
        site: deps.config.dk.site,
        wsRegion: deps.config.dk.wsRegion,
        leagueId: deps.config.dk.leagueId,
        subcategoryId: deps.config.dk.subcategoryId,
        feed: deps.config.feed,
      },
      process: {
        node: process.version,
        platform: process.platform,
        uptimeSec: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      sseClients: deps.hub.clientCount,
    });
  });

  app.get('/healthz', (c) => {
    const meta = deps.feed.meta();
    return c.json({
      ok: true,
      feedState: meta.feedState,
      stale: meta.stale,
      lastContactAt: meta.lastContactAt,
    });
  });

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
