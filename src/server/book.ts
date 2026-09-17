import type {
  BookId,
  Game,
  GameStatus,
  LiveState,
  MarketType,
  Odds,
  PollStats,
  SideKey,
  Team,
  Transport,
} from '../shared/types.js';

/**
 * The seam for adding another sportsbook: implement `BookAdapter` and hand it to a FeedManager.
 * A book with no push feed simply omits `subscribe` and the manager polls `fetchSnapshot`
 * (that is FanDuel: `fanduel/adapter.ts`).
 */

export interface LeagueRef {
  /** Book-specific league id (DraftKings NFL = "88808"; FanDuel NFL = its page id "nfl") */
  id: string;
  name: string;
  /** DraftKings' "main lines" grouping (NFL Game Lines/Game = "4518"). Books without one omit it. */
  subcategoryId?: string;
}

export interface SnapshotResult {
  games: Game[];
  fetchedAt: string;
  durationMs: number;
  /** Book-specific data needed to open a push subscription (DraftKings: subscriptionPartials). */
  subscriptionSpec?: unknown;
  invalidEntities: number;
  /** True when the upstream answered 304 Not Modified: `games` is empty and the last state stands. */
  notModified?: boolean;
  /** Poll transports: how long the adapter suggests waiting before the next fetch (cache-aware). */
  nextPollInMs?: number;
}

/** A full game as it arrives on a push feed (e.g. a newly listed event). */
export type GameUpsert = Omit<Game, 'markets' | 'book' | 'league'>;

/** Partial game update (status / kickoff / live score). */
export interface GamePatch {
  id: string;
  status?: GameStatus;
  startTime?: string;
  live?: LiveState;
  home?: Team;
  away?: Team;
}

export interface MarketUpsert {
  sourceMarketId: string;
  gameId: string;
  type: MarketType;
  suspended?: boolean;
}

/** Partial market update — DraftKings sends {id, isSuspended} with no eventId during live play. */
export interface MarketPatch {
  sourceMarketId: string;
  suspended?: boolean;
}

export interface SelectionUpsert {
  sourceSelectionId: string;
  /** Present on `add`, absent on `change` (DraftKings) */
  sourceMarketId?: string;
  /** Present when a line moved and the selection was re-keyed */
  replacedSelectionId?: string;
  key?: SideKey;
  label?: string;
  line?: number;
  /** Explicitly "no line" (moneyline) vs unknown (undefined = keep) */
  odds: Odds;
}

/**
 * A book-agnostic delta. Everything is keyed by the book's own ids; the store resolves them
 * with the indices it built from the last snapshot.
 */
export interface NormalizedDelta {
  /** Upstream change time (DraftKings metadata.createdTime) */
  createdAt: string;
  /** Upstream publish time (DraftKings websocketPublishTimestamp) */
  publishedAt: string;
  /** When we received it */
  receivedAt: string;
  games: { upsert: GameUpsert[]; patch: GamePatch[]; remove: string[] };
  markets: { upsert: MarketUpsert[]; patch: MarketPatch[]; remove: string[] };
  selections: { upsert: SelectionUpsert[]; remove: string[] };
  invalidEntities: number;
}

export type SocketState = 'idle' | 'connecting' | 'open' | 'subscribed' | 'closed';

export interface SubscriptionHandlers {
  onDelta(delta: NormalizedDelta): void;
  onState(state: SocketState, detail?: { code?: number; reason?: string }): void;
  /** Fired on subscribe acks: lets the caller estimate clock skew and mark contact. */
  onAck(info: { rttMs: number; skewMs: number; at: string }): void;
  /** Any upstream activity (message, pong) — used for "last contact". */
  onActivity(at: string): void;
  onError(err: Error): void;
}

export interface Subscription {
  close(): void;
}

export interface BookAdapter {
  readonly book: BookId;
  readonly site: string;
  readonly transport: Transport;
  fetchSnapshot(league: LeagueRef, signal?: AbortSignal): Promise<SnapshotResult>;
  /** Optional push feed. `spec` is the `subscriptionSpec` from the latest snapshot, if any. */
  subscribe?(league: LeagueRef, spec: unknown, handlers: SubscriptionHandlers): Subscription;
  /** Poll transports: cache/freshness statistics for the UI. */
  pollStats?(): PollStats;
}
