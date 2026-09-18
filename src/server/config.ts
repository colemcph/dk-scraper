export interface AppConfig {
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  dk: {
    /** DraftKings site key, e.g. dkcaon (Ontario), dkusoh (Ohio) */
    site: string;
    /** WebSocket host region, e.g. ca-on, us-oh */
    wsRegion: string;
    leagueId: string;
    leagueName: string;
    /** "Game" subcategory under "Game Lines" (main markets). NFL = 4518. */
    subcategoryId: string;
    /** Override the snapshot API origin (chaos tests, proxies). Default: sportsbook-nash.draftkings.com */
    restBaseUrl?: string;
    /** Override the full socket URL (chaos tests). Default: wss://sportsbook-ws-{region}.draftkings.com/websocket?... */
    wsUrl?: string;
  };
  fd: {
    enabled: boolean;
    /** FanDuel region/state code: on = Ontario. Their US site (`.com`) refuses Canadian IPs with a 400. */
    region: string;
    /** FanDuel page id for the league: nfl, nba, mlb, nhl, ... */
    pageId: string;
    leagueName: string;
    /** The public `_ak` key FanDuel's own bundle sends. */
    apiKey: string;
    timezone: string;
    /** Fast poll cadence (ms) for the structure page. The adapter sleeps through the CDN's max-age and polls at this rate around its expiry. */
    pollIntervalMs: number;
    /** Cadence (ms) for the uncached live price channel (getMarketPrices). FanDuel's own client uses 5 s. */
    priceIntervalMs: number;
    /** Turn the live price channel off and take prices from the cached page instead. */
    pricesEnabled: boolean;
    /** Override the price API origin (chaos tests). Default: https://smp.{region}.sportsbook.fanduel.ca */
    priceBaseUrl?: string;
    /** Defeat the CDN cache with a unique query string (every poll hits FanDuel's origin). Off by default. */
    bypassCache: boolean;
    /** Override the API origin (chaos tests). Default: https://sbapi.{region}.sportsbook.fanduel.ca/api */
    restBaseUrl?: string;
  };
  feed: {
    resyncIntervalMs: number;
    pollIntervalMs: number;
    wsFallbackAfterMs: number;
    staleAfterMs: number;
    refreshMinIntervalMs: number;
  };
  sse: {
    heartbeatIntervalMs: number;
  };
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${name}: ${raw}`);
  return n;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`Invalid ${name}: ${raw}`);
}

export function loadConfig(): AppConfig {
  const logLevel = str('LOG_LEVEL', 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL: ${logLevel}`);
  }
  return {
    port: int('PORT', 3000),
    logLevel: logLevel as AppConfig['logLevel'],
    dk: {
      site: str('DK_SITE', 'dkcaon'),
      wsRegion: str('DK_WS_REGION', 'ca-on'),
      leagueId: str('DK_LEAGUE_ID', '88808'),
      leagueName: str('DK_LEAGUE_NAME', ''),
      subcategoryId: str('DK_SUBCATEGORY_ID', '4518'),
      ...(process.env.DK_REST_BASE_URL ? { restBaseUrl: process.env.DK_REST_BASE_URL } : {}),
      ...(process.env.DK_WS_URL ? { wsUrl: process.env.DK_WS_URL } : {}),
    },
    fd: {
      enabled: bool('FD_ENABLED', true),
      region: str('FD_REGION', 'on'),
      pageId: str('FD_PAGE_ID', 'nfl'),
      leagueName: str('FD_LEAGUE_NAME', ''),
      apiKey: str('FD_API_KEY', 'FhMFpcPWXMeyZxOx'),
      timezone: str('FD_TIMEZONE', 'America/Toronto'),
      pollIntervalMs: int('FD_POLL_INTERVAL_MS', 1_000),
      priceIntervalMs: int('FD_PRICE_INTERVAL_MS', 5_000),
      pricesEnabled: bool('FD_PRICES_ENABLED', true),
      bypassCache: bool('FD_CACHE_BYPASS', false),
      ...(process.env.FD_REST_BASE_URL ? { restBaseUrl: process.env.FD_REST_BASE_URL } : {}),
      ...(process.env.FD_PRICE_BASE_URL ? { priceBaseUrl: process.env.FD_PRICE_BASE_URL } : {}),
    },
    feed: {
      resyncIntervalMs: int('RESYNC_INTERVAL_MS', 60_000),
      pollIntervalMs: int('POLL_INTERVAL_MS', 3_000),
      wsFallbackAfterMs: int('WS_FALLBACK_AFTER_MS', 15_000),
      staleAfterMs: int('STALE_AFTER_MS', 90_000),
      refreshMinIntervalMs: int('REFRESH_MIN_INTERVAL_MS', 5_000),
    },
    sse: {
      heartbeatIntervalMs: int('HEARTBEAT_INTERVAL_MS', 10_000),
    },
  };
}
