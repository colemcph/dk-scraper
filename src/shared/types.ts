/**
 * The clean, book-agnostic shape everything downstream consumes.
 * DraftKings' payloads are mapped into this in `books/draftkings/normalize.ts`;
 * the store, the SSE stream and the React UI never see raw DraftKings entities.
 */

export type BookId = 'draftkings';
export type MarketType = 'moneyline' | 'spread' | 'total';
export type SideKey = 'home' | 'away' | 'over' | 'under';
export type GameStatus = 'upcoming' | 'live' | 'finished';

export interface Odds {
  /** e.g. -110, +260 (ASCII sign, never the Unicode minus DraftKings emits) */
  american: number;
  /** e.g. 1.91, 3.60 */
  decimal: number;
}

export interface SidePrev {
  line?: number;
  odds: Odds;
  /** When the value shown in `prev` stopped being current (ISO). */
  changedAt: string;
}

export interface Side {
  key: SideKey;
  /** "DET Lions", "Over", ... */
  label: string;
  /** Spread points for this side (signed) or the total. Absent for moneyline. */
  line?: number;
  odds: Odds;
  /** The last different value, kept until the next change (UI decides how long to show it). */
  prev?: SidePrev;
  /** DraftKings' `createdTime` for socket updates, our fetch time for snapshot-derived values. */
  updatedAt: string;
  /** Opaque upstream id, kept for tracing only. */
  sourceSelectionId: string;
}

export interface Market {
  type: MarketType;
  sides: Partial<Record<SideKey, Side>>;
  /** DraftKings' own isSuspended flag (set during live plays); sides may still be present. */
  suspended: boolean;
  updatedAt: string;
  sourceMarketId: string;
}

export interface Team {
  id: string;
  name: string;
  shortName: string;
  color?: string;
}

export interface LiveState {
  /** "1st Quarter", "5th", ... as DraftKings labels it */
  period?: string;
  /** "13:45" — time left in the period, when DraftKings provides it */
  clock?: string;
  homeScore?: number;
  awayScore?: number;
  clockRunning?: boolean;
}

export interface Game {
  id: string;
  book: BookId;
  league: string;
  /** ISO kickoff time */
  startTime: string;
  status: GameStatus;
  home: Team;
  away: Team;
  live?: LiveState;
  /** null = DraftKings is not offering that market right now */
  markets: Record<MarketType, Market | null>;
  updatedAt: string;
}

export type FeedState =
  /** no snapshot yet */
  | 'bootstrapping'
  /** socket connected & subscribed; deltas flowing */
  | 'live'
  /** socket dropped; reconnecting with backoff, still serving last-known-good */
  | 'reconnecting'
  /** socket unavailable for too long; polling the snapshot API instead */
  | 'polling'
  /** DraftKings unreachable; serving last-known-good (if any) and retrying */
  | 'degraded';

export interface LatencyStats {
  samples: number;
  /** DraftKings odds-engine `createdTime` -> our server, skew-corrected. */
  p50Ms: number | null;
  p95Ms: number | null;
  lastMs: number | null;
  /** createdTime -> websocketPublishTimestamp: DraftKings' own pipeline, their clocks only. */
  pipelineP50Ms: number | null;
  /** websocketPublishTimestamp -> our receipt, skew-corrected: the network leg. */
  transportP50Ms: number | null;
  transportMinMs: number | null;
  /** Self-check: transport samples that came out negative (should stay 0 if the skew is right). */
  negativeTransportSamples: number;
  /** DraftKings clock minus our clock. */
  clockSkewMs: number | null;
  /** 'ack' = from the subscribe round trip; 'tracked' = continuously refined from frames. */
  skewSource: 'ack' | 'tracked' | null;
  /** Tightest subscribe round trip seen (bounds the skew uncertainty at RTT/2). */
  skewRttMs: number | null;
}

export interface FeedCounters {
  socketUpdates: number;
  socketReconnects: number;
  restSnapshots: number;
  restFailures: number;
  /** Selections that arrived on the socket but couldn't be placed (=> resync). */
  unresolvedDeltas: number;
  /** Differences found by a periodic resync while the socket was live. Should stay ~0. */
  driftCorrections: number;
  /** Snapshot fields ignored because the socket had already delivered something newer. */
  staleSnapshotSkips: number;
  invalidEntities: number;
}

export interface FeedMeta {
  book: BookId;
  league: string;
  leagueName: string;
  /** DraftKings site key, e.g. dkcaon (Ontario) */
  site: string;
  feedState: FeedState;
  /** True when we have not had a successful exchange with DraftKings for STALE_AFTER_MS. */
  stale: boolean;
  lastContactAt: string | null;
  lastChangeAt: string | null;
  lastSnapshotAt: string | null;
  socketConnectedAt: string | null;
  lastError: { at: string; message: string } | null;
  serverTime: string;
  startedAt: string;
  version: number;
  latency: LatencyStats;
  counters: FeedCounters;
}

export interface OddsSnapshot {
  version: number;
  games: Game[];
  meta: FeedMeta;
}

export type ChangeField = 'odds' | 'line';

export interface UpdateLatency {
  dkCreatedAt: string;
  dkPublishedAt: string;
  serverReceivedAt: string;
  /** createdTime -> websocketPublishTimestamp, both DraftKings clocks */
  dkPipelineMs: number;
  /** createdTime -> our receive, skew-corrected when a skew estimate exists */
  dkToServerMs: number;
  skewCorrected: boolean;
}

export interface OddsChange {
  gameId: string;
  market: MarketType;
  side: SideKey;
  field: ChangeField;
  prevLine?: number;
  nextLine?: number;
  prevOdds?: Odds;
  nextOdds: Odds;
  at: string;
  source: 'socket' | 'snapshot';
  latency?: UpdateLatency;
}

/** `event: delta` on the SSE stream */
export interface DeltaEvent {
  version: number;
  /** Full objects for every game touched by this update. */
  games: Game[];
  removedGameIds: string[];
  changes: OddsChange[];
  meta: FeedMeta;
  emittedAt: string;
}

/** `event: heartbeat` on the SSE stream */
export interface HeartbeatEvent {
  serverTime: string;
  version: number;
  feedState: FeedState;
  stale: boolean;
}
