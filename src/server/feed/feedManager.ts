import type {
  DeltaEvent,
  FeedCounters,
  FeedMeta,
  FeedState,
  OddsSnapshot,
} from '../../shared/types.js';
import type {
  BookAdapter,
  LeagueRef,
  NormalizedDelta,
  SnapshotResult,
  SocketState,
  Subscription,
} from '../books/types.js';
import { errorMessage, type Logger } from '../logger.js';
import { LatencyTracker } from './latency.js';
import type { ChangeSet, OddsStore } from './store.js';

export interface FeedConfig {
  resyncIntervalMs: number;
  pollIntervalMs: number;
  wsFallbackAfterMs: number;
  staleAfterMs: number;
  refreshMinIntervalMs: number;
  /** Backoff for snapshot retries while we have nothing to show. */
  bootstrapBackoffBaseMs?: number;
  bootstrapBackoffMaxMs?: number;
  /** Debounce for resyncs triggered by unresolved socket deltas. */
  unresolvedResyncDelayMs?: number;
  staleCheckIntervalMs?: number;
}

export interface FeedManagerOptions {
  adapter: BookAdapter;
  league: LeagueRef;
  store: OddsStore;
  logger: Logger;
  config: FeedConfig;
  latency?: LatencyTracker;
  now?: () => number;
}

export type ResyncReason =
  'bootstrap' | 'periodic' | 'reconnect' | 'unresolved' | 'poll' | 'manual';

type Listener<T> = (payload: T) => void;

/**
 * Owns the upstream relationship with one book/league and turns it into a stream of events:
 *
 *   BOOTSTRAPPING --snapshot ok--> LIVE (socket subscribed) --socket closed--> RECONNECTING
 *        |                           ^        |                                     |
 *        | snapshot fails            |        +--- periodic / unresolved --> RESYNC   | > wsFallbackAfterMs
 *        v                           |                                               v
 *     DEGRADED (retry w/ backoff)    +---------------- socket back ---------------- POLLING (REST every pollIntervalMs)
 *
 * Whatever the state, the last-known-good snapshot is never dropped, and `meta()` tells the UI
 * exactly which state we are in and when we last heard from DraftKings.
 */
export class FeedManager {
  private state: FeedState = 'bootstrapping';
  private socketState: SocketState = 'idle';
  private subscription: Subscription | null = null;
  private subscriptionSpec: unknown = undefined;
  private everSubscribed = false;

  private lastContactAt: number | null = null;
  private lastChangeAt: number | null = null;
  private lastSnapshotAt: number | null = null;
  private socketConnectedAt: number | null = null;
  private lastError: { at: string; message: string } | null = null;
  private lastRefreshAt = 0;
  private lastStaleFlag = false;
  private readonly startedAt: number;
  private leagueName: string;

  private readonly counters: FeedCounters = {
    socketUpdates: 0,
    socketReconnects: 0,
    restSnapshots: 0,
    restFailures: 0,
    unresolvedDeltas: 0,
    driftCorrections: 0,
    staleSnapshotSkips: 0,
    invalidEntities: 0,
  };
  private unresolvedDelayMs = 0;
  private lastUnresolvedAt = 0;

  private stopped = false;
  private bootstrapAttempt = 0;
  private resyncInFlight: Promise<ChangeSet | null> | null = null;
  private timers: {
    bootstrap?: NodeJS.Timeout;
    resync?: NodeJS.Timeout;
    poll?: NodeJS.Timeout;
    fallback?: NodeJS.Timeout;
    stale?: NodeJS.Timeout;
    unresolved?: NodeJS.Timeout;
  } = {};

  private readonly listeners = {
    delta: new Set<Listener<DeltaEvent>>(),
    meta: new Set<Listener<FeedMeta>>(),
  };
  private readonly latency: LatencyTracker;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: FeedManagerOptions) {
    this.latency = opts.latency ?? new LatencyTracker();
    this.now = opts.now ?? Date.now;
    this.log = opts.logger.child('feed');
    this.startedAt = this.now();
    this.leagueName = opts.league.name;
  }

  /* ------------------------------------------------------------------------ public API */

  on(event: 'delta', listener: Listener<DeltaEvent>): () => void;
  on(event: 'meta', listener: Listener<FeedMeta>): () => void;
  on(event: 'delta' | 'meta', listener: Listener<DeltaEvent> | Listener<FeedMeta>): () => void {
    const set = this.listeners[event] as Set<Listener<unknown>>;
    set.add(listener as Listener<unknown>);
    return () => set.delete(listener as Listener<unknown>);
  }

  start(): void {
    this.stopped = false;
    this.timers.stale = setInterval(
      () => this.checkStale(),
      this.opts.config.staleCheckIntervalMs ?? 5_000,
    );
    this.timers.resync = setInterval(() => {
      if (this.state === 'live') void this.resync('periodic');
    }, this.opts.config.resyncIntervalMs);
    void this.bootstrap();
  }

  stop(): void {
    this.stopped = true;
    for (const t of Object.values(this.timers)) if (t) clearTimeout(t);
    this.timers = {};
    this.subscription?.close();
    this.subscription = null;
  }

  get feedState(): FeedState {
    return this.state;
  }

  snapshot(): OddsSnapshot {
    return { version: this.opts.store.version, games: this.opts.store.list(), meta: this.meta() };
  }

  meta(): FeedMeta {
    const now = this.now();
    return {
      book: this.opts.adapter.book,
      league: this.opts.league.id,
      leagueName: this.leagueName,
      site: this.opts.adapter.site,
      feedState: this.state,
      stale: this.isStale(now),
      lastContactAt: iso(this.lastContactAt),
      lastChangeAt: iso(this.lastChangeAt),
      lastSnapshotAt: iso(this.lastSnapshotAt),
      socketConnectedAt: iso(this.socketConnectedAt),
      lastError: this.lastError,
      serverTime: new Date(now).toISOString(),
      startedAt: new Date(this.startedAt).toISOString(),
      version: this.opts.store.version,
      latency: this.latency.stats(),
      counters: { ...this.counters },
    };
  }

  /** The Refresh button: a rate-limited, user-triggered resync. */
  async refresh(): Promise<{
    ok: boolean;
    retryAfterMs?: number;
    changes: number;
    meta: FeedMeta;
  }> {
    const now = this.now();
    const wait = this.opts.config.refreshMinIntervalMs - (now - this.lastRefreshAt);
    if (wait > 0) return { ok: false, retryAfterMs: wait, changes: 0, meta: this.meta() };
    this.lastRefreshAt = now;
    const result = await this.resync('manual');
    return { ok: result !== null, changes: result?.changes.length ?? 0, meta: this.meta() };
  }

  /* ------------------------------------------------------------------------ bootstrap */

  private async bootstrap(): Promise<void> {
    if (this.stopped) return;
    try {
      const res = await this.opts.adapter.fetchSnapshot(this.opts.league);
      this.bootstrapAttempt = 0;
      this.onSnapshot(res, 'bootstrap');
      if (this.opts.adapter.subscribe) {
        this.openSocket();
      } else {
        this.setState('polling');
        this.startPolling();
      }
    } catch (err) {
      this.counters.restFailures++;
      this.recordError(err);
      this.setState('degraded');
      const base = this.opts.config.bootstrapBackoffBaseMs ?? 1_000;
      const max = this.opts.config.bootstrapBackoffMaxMs ?? 30_000;
      const delay = Math.round(
        Math.min(max, base * 2 ** this.bootstrapAttempt) * (0.7 + Math.random() * 0.6),
      );
      this.bootstrapAttempt++;
      this.log.warn('bootstrap failed; retrying', {
        delayMs: delay,
        attempt: this.bootstrapAttempt,
      });
      this.timers.bootstrap = setTimeout(() => void this.bootstrap(), delay);
    }
  }

  /* ------------------------------------------------------------------------ snapshots */

  /** Single-flight snapshot fetch + apply. Returns null when DraftKings could not be reached. */
  resync(reason: ResyncReason): Promise<ChangeSet | null> {
    if (this.resyncInFlight) return this.resyncInFlight;
    this.resyncInFlight = this.doResync(reason).finally(() => {
      this.resyncInFlight = null;
    });
    return this.resyncInFlight;
  }

  private async doResync(reason: ResyncReason): Promise<ChangeSet | null> {
    if (this.stopped) return null;
    try {
      const res = await this.opts.adapter.fetchSnapshot(this.opts.league);
      const cs = this.onSnapshot(res, reason);
      if (this.state === 'degraded') {
        const next: FeedState = this.socketState === 'subscribed' ? 'live' : 'polling';
        this.setState(next);
        if (next === 'polling') this.startPolling();
      }
      return cs;
    } catch (err) {
      this.counters.restFailures++;
      this.recordError(err);
      this.log.warn('snapshot fetch failed', { reason, error: errorMessage(err) });
      if (this.state === 'polling' || this.state === 'reconnecting') this.setState('degraded');
      return null;
    }
  }

  private onSnapshot(res: SnapshotResult, reason: ResyncReason): ChangeSet {
    const now = this.now();
    this.counters.restSnapshots++;
    this.counters.invalidEntities += res.invalidEntities;
    if (res.subscriptionSpec !== undefined) this.subscriptionSpec = res.subscriptionSpec;
    this.lastContactAt = now;
    this.lastSnapshotAt = now;

    const cs = this.opts.store.applySnapshot(res.games, res.fetchedAt);
    this.counters.staleSnapshotSkips += cs.skippedStale;
    this.log.info('snapshot applied', {
      reason,
      games: res.games.length,
      durationMs: res.durationMs,
      changes: cs.changes.length,
      touched: cs.touchedGameIds.length,
      removed: cs.removedGameIds.length,
      skippedStale: cs.skippedStale,
    });
    if (
      cs.changes.length > 0 &&
      this.state === 'live' &&
      (reason === 'periodic' || reason === 'manual')
    ) {
      // The socket should have told us already. Non-zero here means a missed delta.
      this.counters.driftCorrections += cs.changes.length;
      this.log.warn('resync found changes the socket did not deliver', {
        count: cs.changes.length,
      });
    }
    if (cs.changes.length > 0) this.lastChangeAt = now;
    if (cs.changed) this.emitDelta(cs);
    else this.emitMeta();
    return cs;
  }

  /* ------------------------------------------------------------------------ socket */

  private openSocket(): void {
    if (this.stopped || this.subscription || !this.opts.adapter.subscribe) return;
    this.subscription = this.opts.adapter.subscribe(this.opts.league, this.subscriptionSpec, {
      onState: (state, detail) => this.onSocketState(state, detail),
      onDelta: (delta) => this.onSocketDelta(delta),
      onAck: ({ rttMs, skewMs, at }) => {
        this.latency.recordSkew(skewMs, rttMs);
        this.touch(Date.parse(at));
        this.log.info('socket subscribed', { rttMs, skewMs: Math.round(skewMs) });
      },
      onActivity: (at) => this.touch(Date.parse(at)),
      onError: (err) => {
        this.recordError(err);
        this.log.warn('socket error', { error: err.message });
      },
    });
    this.armFallback();
  }

  private onSocketState(state: SocketState, detail?: { code?: number; reason?: string }): void {
    this.socketState = state;
    if (state === 'subscribed') {
      const reconnect = this.everSubscribed;
      this.everSubscribed = true;
      if (reconnect) this.counters.socketReconnects++;
      this.socketConnectedAt = this.now();
      this.disarmFallback();
      this.stopPolling();
      this.setState('live');
      // Anything that moved while we were away is only visible in a fresh snapshot.
      if (reconnect) void this.resync('reconnect');
      return;
    }
    if (state === 'closed') {
      this.socketConnectedAt = null;
      this.log.warn('socket closed', { code: detail?.code, reason: detail?.reason });
      if (this.state === 'live') this.setState('reconnecting');
      if (!this.stopped) this.armFallback();
    }
  }

  private onSocketDelta(delta: NormalizedDelta): void {
    const now = this.now();
    this.counters.socketUpdates++;
    this.counters.invalidEntities += delta.invalidEntities;
    this.touch(now);

    const latency = this.latency.record(delta.createdAt, delta.publishedAt, delta.receivedAt);
    const result = this.opts.store.applyDelta(delta, latency);

    if (result.unresolved.length > 0) {
      this.counters.unresolvedDeltas += result.unresolved.length;
      this.log.warn('delta referenced unknown entities; scheduling resync', {
        sample: result.unresolved.slice(0, 3),
      });
      this.scheduleUnresolvedResync();
    }
    if (result.changes.length > 0) this.lastChangeAt = now;
    if (result.changed) this.emitDelta(result);
  }

  /** Debounced, with exponential backoff so a stream of foreign ids can't turn into a poll loop. */
  private scheduleUnresolvedResync(): void {
    if (this.timers.unresolved) return;
    const base = this.opts.config.unresolvedResyncDelayMs ?? 5_000;
    const now = this.now();
    if (now - this.lastUnresolvedAt > 2 * 60_000) this.unresolvedDelayMs = 0;
    this.unresolvedDelayMs =
      this.unresolvedDelayMs === 0 ? base : Math.min(60_000, this.unresolvedDelayMs * 2);
    this.lastUnresolvedAt = now;
    this.timers.unresolved = setTimeout(() => {
      this.timers.unresolved = undefined;
      void this.resync('unresolved');
    }, this.unresolvedDelayMs);
  }

  private armFallback(): void {
    if (this.timers.fallback) return;
    this.timers.fallback = setTimeout(() => {
      this.timers.fallback = undefined;
      if (this.socketState === 'subscribed' || this.stopped) return;
      this.log.warn('socket unavailable; falling back to polling', {
        pollIntervalMs: this.opts.config.pollIntervalMs,
      });
      this.setState('polling');
      this.startPolling();
    }, this.opts.config.wsFallbackAfterMs);
  }

  private disarmFallback(): void {
    if (this.timers.fallback) clearTimeout(this.timers.fallback);
    this.timers.fallback = undefined;
  }

  /* ------------------------------------------------------------------------ polling */

  private startPolling(): void {
    if (this.timers.poll) return;
    this.timers.poll = setInterval(() => void this.resync('poll'), this.opts.config.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.timers.poll) clearInterval(this.timers.poll);
    this.timers.poll = undefined;
  }

  /* ------------------------------------------------------------------------ helpers */

  private setState(next: FeedState): void {
    if (this.state === next) return;
    this.log.info('feed state', { from: this.state, to: next });
    this.state = next;
    this.emitMeta();
  }

  private touch(at: number): void {
    if (!Number.isFinite(at)) at = this.now();
    if (this.lastContactAt === null || at > this.lastContactAt) this.lastContactAt = at;
  }

  private isStale(now: number): boolean {
    return this.lastContactAt === null || now - this.lastContactAt > this.opts.config.staleAfterMs;
  }

  private checkStale(): void {
    const stale = this.isStale(this.now());
    if (stale !== this.lastStaleFlag) {
      this.lastStaleFlag = stale;
      this.log.warn(stale ? 'feed is stale' : 'feed is fresh again');
      this.emitMeta();
    }
  }

  private recordError(err: unknown): void {
    this.lastError = {
      at: new Date(this.now()).toISOString(),
      message: errorMessage(err).slice(0, 300),
    };
  }

  private emitDelta(cs: ChangeSet): void {
    const games = cs.touchedGameIds
      .map((id) => this.opts.store.getGame(id))
      .filter((g): g is NonNullable<typeof g> => g !== undefined);
    const event: DeltaEvent = {
      version: this.opts.store.version,
      games,
      removedGameIds: cs.removedGameIds,
      changes: cs.changes,
      meta: this.meta(),
      emittedAt: new Date(this.now()).toISOString(),
    };
    for (const l of this.listeners.delta) l(event);
  }

  private emitMeta(): void {
    const meta = this.meta();
    for (const l of this.listeners.meta) l(meta);
  }
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
