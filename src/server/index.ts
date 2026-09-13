import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DraftKingsAdapter } from './books/draftkings/index.js';
import { loadConfig } from './config.js';
import { FeedManager } from './feed/feedManager.js';
import { OddsStore } from './feed/store.js';
import { createApp } from './http/app.js';
import { createLogger } from './logger.js';
import { SseHub } from './sse/hub.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

const league = {
  id: config.dk.leagueId,
  name: config.dk.leagueName,
  subcategoryId: config.dk.subcategoryId,
};

const adapter = new DraftKingsAdapter({
  site: config.dk.site,
  wsRegion: config.dk.wsRegion,
  logger,
});
const store = new OddsStore(league.id);
const feed = new FeedManager({ adapter, league, store, logger, config: config.feed });
const hub = new SseHub({ feed, logger, heartbeatIntervalMs: config.sse.heartbeatIntervalMs });

// dist/server/index.js -> dist/web ; src/server/index.ts (tsx dev) -> no static, Vite serves the UI.
const here = dirname(fileURLToPath(import.meta.url));
const staticCandidate = resolve(here, '../web');
const staticRoot = existsSync(resolve(staticCandidate, 'assets'))
  ? relativeToCwd(staticCandidate)
  : undefined;

const app = createApp({
  feed,
  hub,
  config,
  logger,
  staticRoot,
  version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? process.env.GIT_COMMIT?.slice(0, 7),
});

feed.start();
hub.start();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  logger.info('listening', {
    port: info.port,
    site: config.dk.site,
    wsRegion: config.dk.wsRegion,
    league: league.name,
    staticRoot: staticRoot ?? '(none: run `npm run dev:web` for the UI)',
  });
});

function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  hub.stop();
  feed.stop();
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
