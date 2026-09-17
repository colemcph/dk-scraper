import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  BookId,
  DeltaEvent,
  FeedMeta,
  Game,
  HeartbeatEvent,
  MarketType,
  OddsChange,
  OddsSnapshot,
  SideKey,
} from '../shared/types.js';
import { BOOK_SHORT } from './format.js';
import { estimateClockOffset } from './timeSync.js';

export type Connection = 'connecting' | 'open' | 'reconnecting';
export type FlashKind = 'up' | 'down' | 'line';

export interface Flash {
  kind: FlashKind;
  at: number;
}

export interface RecentMove extends OddsChange {
  book: BookId;
  gameLabel: string;
  sideLabel: string;
  /** browser receipt, browser clock */
  browserReceivedAt: number;
  /** server emit -> browser receipt, corrected for clock offset (null until the offset is known) */
  serverToBrowserMs: number | null;
}

/** One book's slice of the stream: its games, its feed meta, its store version. */
export interface BookState {
  games: Record<string, Game>;
  meta: FeedMeta | null;
  version: number;
}

export interface FeedClientState {
  books: Partial<Record<BookId, BookState>>;
  connection: Connection;
  lastMessageAt: number | null;
  lastHeartbeat: HeartbeatEvent | null;
  /** Newest first, every book. */
  moves: RecentMove[];
  flashes: Record<string, Flash>;
  /** browser - server, ms */
  clockOffsetMs: number | null;
  clockRttMs: number | null;
  browserLegSamples: number[];
}

export type Action =
  | { type: 'snapshot'; snapshot: OddsSnapshot; at: number }
  | { type: 'delta'; delta: DeltaEvent; at: number; offset: number | null }
  | { type: 'meta'; meta: FeedMeta; at: number }
  | { type: 'heartbeat'; heartbeat: HeartbeatEvent; at: number }
  | { type: 'connection'; connection: Connection }
  | { type: 'offset'; offsetMs: number; rttMs: number }
  | { type: 'prune'; at: number };

export const FLASH_MS = 1_800;
/** Enough history for the cross-book "who moved first" pairing; the list itself shows fewer. */
const MAX_MOVES = 200;
const MAX_LEG_SAMPLES = 200;

export function cellKey(book: BookId, gameId: string, market: MarketType, side: SideKey): string {
  return `${book}:${gameId}:${market}:${side}`;
}

const emptyBook = (): BookState => ({ games: {}, meta: null, version: 0 });

export const initialState: FeedClientState = {
  books: {},
  connection: 'connecting',
  lastMessageAt: null,
  lastHeartbeat: null,
  moves: [],
  flashes: {},
  clockOffsetMs: null,
  clockRttMs: null,
  browserLegSamples: [],
};

function flashKind(change: OddsChange): FlashKind {
  if (change.field === 'line') return 'line';
  if (!change.prevOdds) return 'up';
  return change.nextOdds.decimal > change.prevOdds.decimal ? 'up' : 'down';
}

export function reducer(state: FeedClientState, action: Action): FeedClientState {
  switch (action.type) {
    case 'snapshot': {
      const book = action.snapshot.meta.book;
      const games: Record<string, Game> = {};
      for (const g of action.snapshot.games) games[g.id] = g;
      return {
        ...state,
        books: {
          ...state.books,
          [book]: { games, meta: action.snapshot.meta, version: action.snapshot.version },
        },
        lastMessageAt: action.at,
        connection: 'open',
      };
    }
    case 'delta': {
      const { delta, at, offset } = action;
      const book = delta.meta.book;
      const current = state.books[book] ?? emptyBook();
      const games = { ...current.games };
      for (const g of delta.games) games[g.id] = g;
      for (const id of delta.removedGameIds) delete games[id];

      const flashes = { ...state.flashes };
      const serverToBrowserMs =
        offset === null ? null : Math.max(0, Math.round(at - offset - Date.parse(delta.emittedAt)));
      const newMoves: RecentMove[] = [];
      for (const change of delta.changes) {
        flashes[cellKey(book, change.gameId, change.market, change.side)] = {
          kind: flashKind(change),
          at,
        };
        const game = games[change.gameId];
        const side = game?.markets[change.market]?.sides[change.side];
        newMoves.push({
          ...change,
          book,
          gameLabel: game ? `${game.away.shortName} @ ${game.home.shortName}` : change.gameId,
          sideLabel: side?.label ?? change.side,
          browserReceivedAt: at,
          serverToBrowserMs,
        });
      }
      const browserLegSamples =
        serverToBrowserMs === null
          ? state.browserLegSamples
          : [...state.browserLegSamples, serverToBrowserMs].slice(-MAX_LEG_SAMPLES);

      return {
        ...state,
        books: { ...state.books, [book]: { games, meta: delta.meta, version: delta.version } },
        lastMessageAt: at,
        flashes,
        moves: [...newMoves.reverse(), ...state.moves].slice(0, MAX_MOVES),
        browserLegSamples,
        connection: 'open',
      };
    }
    case 'meta': {
      const current = state.books[action.meta.book] ?? emptyBook();
      return {
        ...state,
        books: { ...state.books, [action.meta.book]: { ...current, meta: action.meta } },
        lastMessageAt: action.at,
      };
    }
    case 'heartbeat': {
      const books = { ...state.books };
      for (const hb of action.heartbeat.books) {
        const current = books[hb.book];
        if (!current?.meta) continue;
        books[hb.book] = {
          ...current,
          meta: {
            ...current.meta,
            stale: hb.stale,
            feedState: hb.feedState,
            serverTime: action.heartbeat.serverTime,
            lastContactAt: hb.lastContactAt ?? current.meta.lastContactAt,
          },
        };
      }
      return {
        ...state,
        books,
        lastHeartbeat: action.heartbeat,
        lastMessageAt: action.at,
        connection: 'open',
      };
    }
    case 'connection':
      return state.connection === action.connection
        ? state
        : { ...state, connection: action.connection };
    case 'offset':
      return { ...state, clockOffsetMs: action.offsetMs, clockRttMs: action.rttMs };
    case 'prune': {
      let changed = false;
      const flashes: Record<string, Flash> = {};
      for (const [k, f] of Object.entries(state.flashes)) {
        if (action.at - f.at < FLASH_MS * 2) flashes[k] = f;
        else changed = true;
      }
      return changed ? { ...state, flashes } : state;
    }
    default:
      return state;
  }
}

/** How long without any SSE message before we assume the connection is dead and rebuild it. */
const CLIENT_WATCHDOG_MS = 35_000;

interface RefreshBody {
  ok?: boolean;
  retryAfterMs?: number;
  books?: Partial<Record<BookId, { ok: boolean; changes: number; retryAfterMs?: number }>>;
}

export function useOddsFeed() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const offsetRef = useRef<number | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const lastMessageRef = useRef<number>(Date.now());

  const connect = useCallback(() => {
    sourceRef.current?.close();
    const es = new EventSource('/api/stream');
    sourceRef.current = es;
    dispatch({ type: 'connection', connection: 'connecting' });

    const touch = () => {
      lastMessageRef.current = Date.now();
    };
    es.addEventListener('snapshot', (e) => {
      touch();
      dispatch({
        type: 'snapshot',
        snapshot: JSON.parse((e as MessageEvent).data),
        at: Date.now(),
      });
    });
    es.addEventListener('delta', (e) => {
      touch();
      dispatch({
        type: 'delta',
        delta: JSON.parse((e as MessageEvent).data),
        at: Date.now(),
        offset: offsetRef.current,
      });
    });
    es.addEventListener('meta', (e) => {
      touch();
      dispatch({ type: 'meta', meta: JSON.parse((e as MessageEvent).data), at: Date.now() });
    });
    es.addEventListener('heartbeat', (e) => {
      touch();
      dispatch({
        type: 'heartbeat',
        heartbeat: JSON.parse((e as MessageEvent).data),
        at: Date.now(),
      });
    });
    es.onopen = () => dispatch({ type: 'connection', connection: 'open' });
    es.onerror = () => dispatch({ type: 'connection', connection: 'reconnecting' });
  }, []);

  useEffect(() => {
    connect();
    const watchdog = setInterval(() => {
      if (Date.now() - lastMessageRef.current > CLIENT_WATCHDOG_MS) {
        dispatch({ type: 'connection', connection: 'reconnecting' });
        lastMessageRef.current = Date.now();
        connect();
      }
      dispatch({ type: 'prune', at: Date.now() });
    }, 5_000);
    return () => {
      clearInterval(watchdog);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [connect]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const est = await estimateClockOffset();
      if (!cancelled && est) {
        offsetRef.current = est.offsetMs;
        dispatch({ type: 'offset', offsetMs: est.offsetMs, rttMs: est.rttMs });
      }
    };
    void run();
    const timer = setInterval(() => void run(), 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const refresh = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      const body = (await res.json()) as RefreshBody;
      if (res.status === 429) {
        return {
          ok: false,
          message: `Please wait ${Math.ceil((body.retryAfterMs ?? 5000) / 1000)}s`,
        };
      }
      const parts = (
        Object.entries(body.books ?? {}) as [BookId, NonNullable<RefreshBody['books']>[BookId]][]
      )
        .map(([book, r]) => {
          if (!r) return '';
          const note = r.ok
            ? r.changes
              ? `${r.changes} change(s)`
              : 'no changes'
            : r.retryAfterMs !== undefined
              ? 'wait'
              : 'unreachable';
          return `${BOOK_SHORT[book]} ${note}`;
        })
        .filter(Boolean);
      const message = parts.join(' · ') || 'Books unreachable';
      return { ok: res.ok && body.ok === true, message };
    } catch {
      return { ok: false, message: 'Server unreachable' };
    }
  }, []);

  return { state, refresh };
}
