import type { PollStats } from '../../shared/types.js';
import type { BookAdapter, LeagueRef, SnapshotResult } from '../book.js';
import { percentile } from '../latency.js';
import type { Logger } from '../logger.js';
import { normalizeFanDuelPage } from './normalize.js';
import { FdHttpError, FdRestClient, type FdPageResponse, type FdRestOptions } from './rest.js';

export interface FanDuelAdapterOptions {
  /** FanDuel region: `on` = Ontario. */
  region: string;
  apiKey: string;
  timezone: string;
  /** Fast poll cadence (ms): used while the edge copy can change and as the floor everywhere. */
  pollIntervalMs: number;
  bypassCache?: boolean;
  logger: Logger;
  rest?: Partial<FdRestOptions>;
}

/** FanDuel scopes a league by its page id (`customPageId`). */
export const FD_LEAGUES: Record<string, LeagueRef> = {
  NFL: { id: 'nfl', name: 'NFL' },
};

/**
 * When should the next poll happen?
 *
 * The edge copy cannot change before its `max-age` runs out, and `Age` says how far into that
 * window it already is. So after any response: sleep `max-age − age` (at least one fast interval),
 * then poll at the fast cadence until the copy turns over. That catches a refresh within one fast
 * interval of it landing while sending ~3 requests per 30 s cycle instead of 30 — and the polls
 * that do happen are ETag-validated 304s unless the page actually changed.
 *
 * With the cache bypassed every request is an origin read, so the cadence is just the interval.
 */
export function nextPollDelayMs(
  res: Pick<FdPageResponse, 'ageMs' | 'maxAgeMs'>,
  fastMs: number,
  bypassCache = false,
): number {
  if (bypassCache || res.maxAgeMs === null) return fastMs;
  const remaining = res.maxAgeMs - (res.ageMs ?? 0);
  return Math.max(fastMs, remaining);
}

export class FanDuelAdapter implements BookAdapter {
  readonly book = 'fanduel' as const;
  readonly transport = 'poll' as const;
  readonly site: string;
  private readonly rest: FdRestClient;
  private readonly log: Logger;
  private readonly bypassCache: boolean;

  private durations: number[] = [];
  private lastMs: number | null = null;
  private lastStatus: number | null = null;
  private lastPollAt: string | null = null;
  private lastAgeMs: number | null = null;
  private maxAgeMs: number | null = null;
  private lastCacheHit: boolean | null = null;
  private generatedAt: string | null = null;
  private suggestedIntervalMs: number | null = null;

  constructor(private readonly opts: FanDuelAdapterOptions) {
    this.site = opts.region;
    this.log = opts.logger.child('fd');
    this.bypassCache = opts.bypassCache ?? false;
    this.rest = new FdRestClient({
      region: opts.region,
      apiKey: opts.apiKey,
      timezone: opts.timezone,
      bypassCache: this.bypassCache,
      ...(opts.rest ?? {}),
    });
  }

  async fetchSnapshot(league: LeagueRef, signal?: AbortSignal): Promise<SnapshotResult> {
    let res: FdPageResponse;
    try {
      res = await this.rest.fetchPage(league.id, signal);
    } catch (err) {
      this.lastStatus = err instanceof FdHttpError ? err.status : null;
      this.lastPollAt = new Date().toISOString();
      throw err;
    }
    this.record(res);
    const nextPollInMs = nextPollDelayMs(res, this.opts.pollIntervalMs, this.bypassCache);
    this.suggestedIntervalMs = nextPollInMs;

    if (res.notModified) {
      return {
        games: [],
        fetchedAt: res.fetchedAt,
        durationMs: res.durationMs,
        invalidEntities: 0,
        notModified: true,
        nextPollInMs,
      };
    }
    const normalized = normalizeFanDuelPage(res.body, league, res.fetchedAt);
    if (normalized.invalidEntities > 0) {
      this.log.warn('page contained entities we could not map', {
        invalid: normalized.invalidEntities,
      });
    }
    return {
      games: normalized.games,
      fetchedAt: res.fetchedAt,
      durationMs: res.durationMs,
      invalidEntities: normalized.invalidEntities,
      nextPollInMs,
    };
  }

  pollStats(): PollStats {
    const sorted = [...this.durations].sort((a, b) => a - b);
    return {
      intervalMs: this.opts.pollIntervalMs,
      suggestedIntervalMs: this.suggestedIntervalMs,
      bypassCache: this.bypassCache,
      p50Ms: sorted.length ? percentile(sorted, 0.5) : null,
      lastMs: this.lastMs,
      cacheMaxAgeMs: this.maxAgeMs,
      lastAgeMs: this.lastAgeMs,
      lastCacheHit: this.lastCacheHit,
      generatedAt: this.generatedAt,
      lastPollAt: this.lastPollAt,
      lastStatus: this.lastStatus,
      etag: this.rest.lastEtag,
    };
  }

  private record(res: FdPageResponse): void {
    this.durations.push(res.durationMs);
    if (this.durations.length > 500) this.durations.shift();
    this.lastMs = res.durationMs;
    this.lastStatus = res.status;
    this.lastPollAt = res.fetchedAt;
    this.lastAgeMs = res.ageMs;
    if (res.maxAgeMs !== null) this.maxAgeMs = res.maxAgeMs;
    this.lastCacheHit = res.cacheHit;
    if (res.dateMs !== null) {
      this.generatedAt = new Date(res.dateMs - (res.ageMs ?? 0)).toISOString();
    }
  }
}
