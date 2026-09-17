/**
 * The clean, book-agnostic shape everything downstream consumes.
 * DraftKings' payloads are mapped into this in `server/draftkings/normalize.ts`, FanDuel's in
 * `server/fanduel/normalize.ts`; the store, the SSE stream and the React UI never see raw
 * sportsbook entities.
 */

export type BookId = 'draftkings' | 'fanduel';
export const BOOK_IDS: readonly BookId[] = ['draftkings', 'fanduel'];
export const BOOK_LABEL: Record<BookId, string> = { draftkings: 'DraftKings', fanduel: 'FanDuel' };

/** How a book delivers changes: DraftKings pushes deltas on a socket; FanDuel has no public push feed. */
export type Transport = 'push' | 'poll';

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
  /** The book's own suspended flag (set during live plays); sides may still be present. */
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
  /** null = the book is not offering that market right now */
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
  /** polling the snapshot API: the normal state for a poll-only book, the fallback for a push book */
  | 'polling'
  /** the book is unreachable; serving last-known-good (if any) and retrying */
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
  /**
   * The same numbers split by whether the game was in play. DraftKings holds in-play prices
   * ~1–2 s before publishing (visible in their own timestamps); pre-game moves publish in ~35 ms.
   */
  byPhase: Record<LatencyPhase, PhaseLatency>;
}

export type LatencyPhase = 'pregame' | 'inplay';

export interface PhaseLatency {
  samples: number;
  /** DraftKings engine -> our server */
  p50Ms: number | null;
  p95Ms: number | null;
  /** of which, inside DraftKings (their clocks only) */
  pipelineP50Ms: number | null;
}

/**
 * Freshness of a polled source. A CDN in front of the book's API bounds how old the copy we
 * receive can be; these fields make that bound visible instead of pretending a poll is "live".
 */
export interface PollStats {
  /** Base poll cadence in use (ms). */
  intervalMs: number;
  /** The delay the adapter asked for before the next poll after reading the cache headers (ms). */
  suggestedIntervalMs: number | null;
  /** True when the adapter is defeating the upstream CDN cache (opt-in; costs the book an origin hit per poll). */
  bypassCache: boolean;
  /** request -> response, ms */
  p50Ms: number | null;
  lastMs: number | null;
  /** `Cache-Control: max-age` the upstream sends: the longest a copy can sit at the edge (ms). */
  cacheMaxAgeMs: number | null;
  /** `Age` of the copy we last received (ms) and whether it came from the edge cache. */
  lastAgeMs: number | null;
  lastCacheHit: boolean | null;
  /** When the copy we hold was generated upstream: response `Date` minus `Age`, upstream's clock. */
  generatedAt: string | null;
  lastPollAt: string | null;
  /** 200 (new body), 304 (not modified) or the last error status. */
  lastStatus: number | null;
  /** The validator we send back as If-None-Match; null if the upstream sends none. */
  etag: string | null;
}

export interface FeedCounters {
  socketUpdates: number;
  socketReconnects: number;
  /** Snapshot fetches that returned a body (HTTP 200). */
  restSnapshots: number;
  /** Snapshot fetches the upstream answered with 304 Not Modified (poll transports). */
  restNotModified: number;
  restFailures: number;
  /** Selections that arrived on the socket but couldn't be placed (=> resync). */
  unresolvedDeltas: number;
  /**
   * Changes a resync found that the socket never delivered (given a grace window, since
   * DraftKings publishes to the socket up to a few seconds after its engine moves a price).
   */
  driftCorrections: number;
  /** Changes a resync saw first that the socket then confirmed inside the grace window. */
  snapshotLeads: number;
  /** Snapshot fields ignored because the socket had already delivered something newer. */
  staleSnapshotSkips: number;
  invalidEntities: number;
}

export interface FeedMeta {
  book: BookId;
  bookName: string;
  transport: Transport;
  league: string;
  leagueName: string;
  /** DraftKings site key (dkcaon = Ontario) or FanDuel region (on = Ontario) */
  site: string;
  feedState: FeedState;
  /** True when we have not had a successful exchange with the book for STALE_AFTER_MS. */
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
  /** Present for poll transports (and null for a push transport). */
  poll: PollStats | null;
}

export interface OddsSnapshot {
  version: number;
  games: Game[];
  meta: FeedMeta;
}

/** `GET /api/odds`: every book's snapshot in one response. */
export interface OddsBundle {
  serverTime: string;
  books: Partial<Record<BookId, OddsSnapshot>>;
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

/** `event: delta` on the SSE stream. `meta.book` says which book it belongs to. */
export interface DeltaEvent {
  version: number;
  /** Full objects for every game touched by this update. */
  games: Game[];
  removedGameIds: string[];
  changes: OddsChange[];
  meta: FeedMeta;
  emittedAt: string;
}

export interface HeartbeatBook {
  book: BookId;
  version: number;
  feedState: FeedState;
  stale: boolean;
  lastContactAt: string | null;
}

/** `event: heartbeat` on the SSE stream */
export interface HeartbeatEvent {
  serverTime: string;
  books: HeartbeatBook[];
}
