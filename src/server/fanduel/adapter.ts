import type { Game, PollStats, PricePollStats } from '../../shared/types.js';
import type { BookAdapter, LeagueRef, SnapshotResult } from '../book.js';
import { percentile } from '../latency.js';
import { errorMessage, type Logger } from '../logger.js';
import { applyMarketPrices, normalizeFanDuelPage } from './normalize.js';
import { FdPricesClient, type FdPricesOptions } from './prices.js';
import { FdHttpError, FdRestClient, type FdPageResponse, type FdRestOptions } from './rest.js';

export interface FanDuelAdapterOptions {
  /** FanDuel region: `on` = Ontario. */
  region: string;
  apiKey: string;
  timezone: string;
  /** Fast poll cadence (ms) for the structure page: used while the edge copy can change. */
  pollIntervalMs: number;
  /** Cadence (ms) for the uncached live price channel. FanDuel's own client uses 5 s. */
  priceIntervalMs: number;
  /** Turn the live price channel off and read prices from the cached page instead. */
  pricesEnabled?: boolean;
  bypassCache?: boolean;
  logger: Logger;
  rest?: Partial<FdRestOptions>;
  prices?: Partial<FdPricesOptions>;
}

/** FanDuel scopes a league by its page id (`customPageId`). */
export const FD_LEAGUES: Record<string, LeagueRef> = {
  NFL: { id: 'nfl', name: 'NFL' },
};

/**
 * When should the *structure page* be fetched again?
 *
 * The edge copy cannot change before its `max-age` runs out, and `Age` says how far into that
 * window it already is. So after any response: sleep `max-age − age` (at least one fast interval),
 * then poll at the fast cadence until the copy turns over — ~3 requests per 30 s cycle instead of
 * 30, each an ETag-validated 304 unless the page really changed.
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

/**
 * FanDuel has no push feed, so this is a poller — but a two-channel one, which is what keeps it
 * close to DraftKings:
 *
 *  - the **page** (`content-managed-page`, behind a 30 s CloudFront cache) is the structure:
 *    which games exist, their teams, kickoffs, and which markets are offered. Re-read only when
 *    its cached copy can actually have changed.
 *  - the **price channel** (`getMarketPrices`, `Cache-Control: no-cache`, ~60 ms) is the numbers,
 *    re-read every `priceIntervalMs`. This is the endpoint FanDuel's own client polls once a
 *    selection is in the betslip, and it is what makes the freshness bound the poll interval
 *    rather than the CDN's max-age.
 *
 * The price channel is strictly an improvement layered on top: if it fails, the adapter serves the
 * page's own prices and says so (`prices.healthy = false`), so the book degrades to its old
 * freshness instead of going down.
 */
export class FanDuelAdapter implements BookAdapter {
  readonly book = 'fanduel' as const;
  readonly transport = 'poll' as const;
  readonly site: string;
  private readonly rest: FdRestClient;
  private readonly prices: FdPricesClient;
  private readonly log: Logger;
  private readonly bypassCache: boolean;
  private readonly pricesEnabled: boolean;

  /** Last page structure, kept between polls so only prices are re-read. */
  private page: { games: Game[]; fetchedAt: string } | null = null;
  private pageDueAt = 0;
  private forcePageRefresh = false;

  private durations: number[] = [];
  private lastMs: number | null = null;
  private lastStatus: number | null = null;
  private lastPollAt: string | null = null;
  private lastAgeMs: number | null = null;
  private maxAgeMs: number | null = null;
  private lastCacheHit: boolean | null = null;
  private generatedAt: string | null = null;
  private suggestedIntervalMs: number | null = null;

  private priceDurations: number[] = [];
  private priceLastMs: number | null = null;
  private priceStatus: number | null = null;
  private pricePollAt: string | null = null;
  private priceMarkets = 0;
  private priceBatches = 0;
  private priceUpdates = 0;
  private priceUnmatched = 0;
  private priceHealthy = true;

  constructor(private readonly opts: FanDuelAdapterOptions) {
    this.site = opts.region;
    this.log = opts.logger.child('fd');
    this.bypassCache = opts.bypassCache ?? false;
    this.pricesEnabled = opts.pricesEnabled ?? true;
    this.rest = new FdRestClient({
      region: opts.region,
      apiKey: opts.apiKey,
      timezone: opts.timezone,
      bypassCache: this.bypassCache,
      ...(opts.rest ?? {}),
    });
    this.prices = new FdPricesClient({ region: opts.region, ...(opts.prices ?? {}) });
  }

  async fetchSnapshot(league: LeagueRef, signal?: AbortSignal): Promise<SnapshotResult> {
    const started = Date.now();
    const pageDue = this.page === null || started >= this.pageDueAt || this.forcePageRefresh;
    let invalidEntities = 0;
    let pageBodyReceived = false;
    let fetchedAt = new Date(started).toISOString();

    if (pageDue) {
      const res = await this.readPage(league, signal);
      invalidEntities += res.invalidEntities;
      pageBodyReceived = !res.notModified; // a 304 leaves the cached structure in place
      fetchedAt = res.fetchedAt;
    }

    const unchanged = (): SnapshotResult => ({
      games: [],
      fetchedAt,
      durationMs: Date.now() - started,
      invalidEntities,
      notModified: true,
      nextPollInMs: this.nextDelay(),
    });

    if (!this.page) return unchanged();

    // The store takes ownership of what it is handed, so never give it the cached objects.
    const games = structuredClone(this.page.games);
    const pricedAt = new Date(Date.now()).toISOString();
    let pricesApplied = false;

    if (this.pricesEnabled) {
      const marketIds = games.flatMap((g) =>
        Object.values(g.markets)
          .filter((m) => m !== null)
          .map((m) => m.sourceMarketId),
      );
      if (marketIds.length > 0) {
        await this.applyPrices(games, marketIds, pricedAt, signal);
        pricesApplied = this.priceHealthy;
      }
    }

    // Nothing was read that could have moved a price: say so, and let the feed skip the diff.
    if (!pageBodyReceived && !pricesApplied) return unchanged();

    return {
      games,
      // Prices are what move, so the snapshot is as of this poll — not the (older) page read.
      fetchedAt: pricesApplied ? pricedAt : this.page.fetchedAt,
      durationMs: Date.now() - started,
      invalidEntities,
      nextPollInMs: this.nextDelay(),
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
      prices: this.pricesEnabled ? this.priceStats() : null,
    };
  }

  /* ---------------------------------------------------------------------------------------- */

  private async readPage(
    league: LeagueRef,
    signal?: AbortSignal,
  ): Promise<{
    notModified: boolean;
    fetchedAt: string;
    invalidEntities: number;
  }> {
    let res: FdPageResponse;
    try {
      res = await this.rest.fetchPage(league.id, signal);
    } catch (err) {
      this.lastStatus = err instanceof FdHttpError ? err.status : null;
      this.lastPollAt = new Date().toISOString();
      throw err;
    }
    this.recordPage(res);
    this.forcePageRefresh = false;
    this.pageDueAt = Date.now() + nextPollDelayMs(res, this.opts.pollIntervalMs, this.bypassCache);

    if (res.notModified) return { notModified: true, fetchedAt: res.fetchedAt, invalidEntities: 0 };

    const normalized = normalizeFanDuelPage(res.body, league, res.fetchedAt);
    if (normalized.invalidEntities > 0) {
      this.log.warn('page contained entities we could not map', {
        invalid: normalized.invalidEntities,
      });
    }
    this.page = { games: normalized.games, fetchedAt: res.fetchedAt };
    return {
      notModified: false,
      fetchedAt: res.fetchedAt,
      invalidEntities: normalized.invalidEntities,
    };
  }

  /** Never fatal: a price failure leaves the page's own prices in place and is reported instead. */
  private async applyPrices(
    games: Game[],
    marketIds: string[],
    at: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.prices.fetchPrices(marketIds, signal);
      const applied = applyMarketPrices(games, result.prices, at);
      this.priceDurations.push(result.durationMs);
      if (this.priceDurations.length > 500) this.priceDurations.shift();
      this.priceLastMs = result.durationMs;
      this.priceStatus = 200;
      this.pricePollAt = result.fetchedAt;
      this.priceMarkets = marketIds.length;
      this.priceBatches = result.batches;
      this.priceUpdates += applied.updated;
      this.priceUnmatched += applied.unmatched;
      this.priceHealthy = true;
      // A re-keyed selection (a line move) only exists on the page, so go and get it.
      if (applied.unmatched > 0 || result.missing.length > 0) {
        this.forcePageRefresh = true;
        this.log.debug('price channel referenced unknown selections; refreshing the page', {
          unmatched: applied.unmatched,
          missingMarkets: result.missing.length,
        });
      }
    } catch (err) {
      this.priceHealthy = false;
      this.priceStatus = err instanceof FdHttpError ? err.status : null;
      this.pricePollAt = new Date().toISOString();
      this.log.warn('live price channel failed; serving the page price instead', {
        error: errorMessage(err),
      });
    }
  }

  /** Prices move, so their cadence drives the poll loop whenever the channel is healthy. */
  private nextDelay(): number {
    const delay =
      this.pricesEnabled && this.priceHealthy
        ? this.opts.priceIntervalMs
        : Math.max(this.opts.pollIntervalMs, this.pageDueAt - Date.now());
    this.suggestedIntervalMs = Math.max(0, Math.round(delay));
    return this.suggestedIntervalMs;
  }

  private priceStats(): PricePollStats {
    const sorted = [...this.priceDurations].sort((a, b) => a - b);
    return {
      intervalMs: this.opts.priceIntervalMs,
      p50Ms: sorted.length ? percentile(sorted, 0.5) : null,
      lastMs: this.priceLastMs,
      lastStatus: this.priceStatus,
      lastPollAt: this.pricePollAt,
      markets: this.priceMarkets,
      batches: this.priceBatches,
      updates: this.priceUpdates,
      unmatched: this.priceUnmatched,
      healthy: this.priceHealthy,
    };
  }

  private recordPage(res: FdPageResponse): void {
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
