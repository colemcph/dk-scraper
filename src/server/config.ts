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
