import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/api.js';
import type { FeedManager } from '../src/server/feed.js';
import { silentLogger } from '../src/server/logger.js';
import { SseHub } from '../src/server/sse.js';
import type { AppConfig } from '../src/server/config.js';
import type { FeedMeta, OddsSnapshot } from '../src/shared/types.js';
import { game } from './helpers.js';

/** A FeedManager stand-in: fixed snapshot, refresh honours the rate limit contract. */
function fakeFeed() {
  const meta = (): FeedMeta =>
    ({
      book: 'draftkings',
      league: '88808',
      leagueName: 'NFL',
      site: 'dkcaon',
      feedState: 'live',
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
    }) as unknown as FeedMeta;
  let refreshes = 0;
  return {
    on: () => () => {},
    snapshot: (): OddsSnapshot => ({ version: 1, games: [game('g1')], meta: meta() }),
    meta,
    refresh: async () => {
      refreshes++;
      return refreshes === 1
        ? { ok: true, changes: 0, meta: meta() }
        : { ok: false, retryAfterMs: 4200, changes: 0, meta: meta() };
    },
  } as unknown as FeedManager;
}

const config = {
  dk: {
    site: 'dkcaon',
    wsRegion: 'ca-on',
    leagueId: '88808',
    leagueName: 'NFL',
    subcategoryId: '4518',
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
    hub = new SseHub({ feed, logger: silentLogger, heartbeatIntervalMs: 60_000 });
    hub.start();
    app = createApp({ feed, hub, config, logger: silentLogger });
  });
  afterEach(() => hub.stop());

  it('serves the normalized snapshot with no-store caching', async () => {
    const res = await app.request('/api/odds');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as OddsSnapshot;
    expect(body.games[0]!.markets.moneyline!.sides.home!.odds.american).toBe(-170);
    expect(body.meta.feedState).toBe('live');
  });

  it('answers the health check and the time endpoint', async () => {
    const health = (await (await app.request('/healthz')).json()) as {
      ok: boolean;
      feedState: string;
    };
    expect(health).toMatchObject({ ok: true, feedState: 'live' });
    const time = (await (await app.request('/api/time')).json()) as { serverTimeMs: number };
    expect(Math.abs(time.serverTimeMs - Date.now())).toBeLessThan(2_000);
  });

  it('rate-limits the Refresh button with a 429 and Retry-After', async () => {
    const first = await app.request('/api/refresh', { method: 'POST' });
    expect(first.status).toBe(200);
    const second = await app.request('/api/refresh', { method: 'POST' });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('5');
    expect(((await second.json()) as { retryAfterMs: number }).retryAfterMs).toBe(4200);
  });

  it('opens an SSE stream that starts with a snapshot event', async () => {
    const res = await app.request('/api/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: snapshot');
    expect(text).toContain('id: 1');
    expect(text).toContain('"leagueName":"NFL"');
    expect(hub.clientCount).toBe(1);
    await reader.cancel();
  });

  it('exposes diagnostics without leaking anything but config and counters', async () => {
    const body = (await (await app.request('/api/diagnostics')).json()) as {
      config: { site: string };
      process: { node: string };
      sseClients: number;
    };
    expect(body.config.site).toBe('dkcaon');
    expect(body.process.node).toBe(process.version);
    expect(body.sseClients).toBe(0);
  });

  it('never turns an unexpected handler error into a crash', async () => {
    const broken = createApp({
      feed: {
        ...fakeFeed(),
        snapshot: () => {
          throw new Error('boom');
        },
      } as unknown as FeedManager,
      hub,
      config,
      logger: silentLogger,
    });
    const res = await broken.request('/api/odds');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
  });
});
