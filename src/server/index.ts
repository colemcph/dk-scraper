import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DK_LEAGUES, DraftKingsAdapter } from './draftkings/adapter.js';
import { FD_LEAGUES, FanDuelAdapter } from './fanduel/adapter.js';
import { loadConfig } from './config.js';
import { FeedManager } from './feed.js';
import { MoveLog } from './moves.js';
import { OddsStore } from './store.js';
import { createApp } from './api.js';
import { createLogger } from './logger.js';
import { SseHub } from './sse.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const feeds: FeedManager[] = [];

// DraftKings: snapshot API + delta socket.
const dkKnown = Object.values(DK_LEAGUES).find((l) => l.id === config.dk.leagueId);
const dkLeague = {
  id: config.dk.leagueId,
  name: config.dk.leagueName || dkKnown?.name || config.dk.leagueId,
  subcategoryId: config.dk.subcategoryId,
};
const dk = new DraftKingsAdapter({
  site: config.dk.site,
  wsRegion: config.dk.wsRegion,
  logger,
  ...(config.dk.restBaseUrl ? { rest: { baseUrl: config.dk.restBaseUrl } } : {}),
  ...(config.dk.wsUrl ? { wsUrl: config.dk.wsUrl } : {}),
});
feeds.push(
  new FeedManager({
    adapter: dk,
    league: dkLeague,
    store: new OddsStore(dkLeague.id, dk.book),
    logger,
    config: config.feed,
  }),
);

// FanDuel: no public push feed, so a cache-aware poller (see fanduel/adapter.ts).
if (config.fd.enabled) {
  const fdKnown = Object.values(FD_LEAGUES).find((l) => l.id === config.fd.pageId);
  const fdLeague = {
    id: config.fd.pageId,
    name: config.fd.leagueName || fdKnown?.name || config.fd.pageId.toUpperCase(),
  };
  const fd = new FanDuelAdapter({
    region: config.fd.region,
    apiKey: config.fd.apiKey,
    timezone: config.fd.timezone,
    pollIntervalMs: config.fd.pollIntervalMs,
    priceIntervalMs: config.fd.priceIntervalMs,
    pricesEnabled: config.fd.pricesEnabled,
    bypassCache: config.fd.bypassCache,
    logger,
    ...(config.fd.restBaseUrl ? { rest: { baseUrl: config.fd.restBaseUrl } } : {}),
    ...(config.fd.priceBaseUrl ? { prices: { baseUrl: config.fd.priceBaseUrl } } : {}),
  });
  feeds.push(
    new FeedManager({
      adapter: fd,
      league: fdLeague,
      store: new OddsStore(fdLeague.id, fd.book),
      logger,
      config: { ...config.feed, pollIntervalMs: config.fd.pollIntervalMs },
    }),
  );
}

const moves = new MoveLog(feeds);
const hub = new SseHub({ feeds, logger, heartbeatIntervalMs: config.sse.heartbeatIntervalMs });

// dist/server/index.js -> dist/web ; src/server/index.ts (tsx dev) -> no static, Vite serves the UI.
const here = dirname(fileURLToPath(import.meta.url));
const staticCandidate = resolve(here, '../web');
const staticRoot = existsSync(resolve(staticCandidate, 'assets'))
  ? relativeToCwd(staticCandidate)
  : undefined;

const app = createApp({
  feeds,
  hub,
  moves,
  config,
  logger,
  staticRoot,
  version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? process.env.GIT_COMMIT?.slice(0, 7),
});

for (const feed of feeds) feed.start();
moves.start();
hub.start();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  logger.info('listening', {
    port: info.port,
    books: feeds.map((f) => f.book),
    dkSite: config.dk.site,
    dkWsRegion: config.dk.wsRegion,
    dkLeague: dkLeague.name,
    fdRegion: config.fd.enabled ? config.fd.region : '(disabled)',
    fdPage: config.fd.enabled ? config.fd.pageId : '(disabled)',
    staticRoot: staticRoot ?? '(none: run `npm run dev:web` for the UI)',
  });
});

function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  hub.stop();
  moves.stop();
  for (const feed of feeds) feed.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

/** hono's serveStatic resolves `root` against process.cwd(). */
function relativeToCwd(abs: string): string {
  const rel = abs.replace(/\\/g, '/');
  const cwd = process.cwd().replace(/\\/g, '/');
  return rel.startsWith(cwd) ? '.' + rel.slice(cwd.length) : rel;
}
