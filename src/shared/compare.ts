import { canonicalTeam, normalizeName } from './teams.js';
import type {
  BookId,
  Game,
  GameStatus,
  MarketType,
  Odds,
  OddsChange,
  SideKey,
  Team,
} from './types.js';

/**
 * Cross-book comparison: the same game at two sportsbooks, side by side, plus "who moved first".
 * Pure functions over the domain model, shared by the server (`/api/compare`) and the browser
 * (the Compare view works off the SSE state it already has).
 */

/** Kickoffs for the same game differ slightly between books (FanDuel lists 17:01 for a 17:00 game). */
export const KICKOFF_TOLERANCE_MS = 24 * 60 * 60_000;

export interface PairTeam {
  /** Canonical id (e.g. "DET") when the registry knows the team, else the normalized name. */
  id: string;
  name: string;
  color?: string;
}

export interface GamePair {
  /** `${away}@${home}` on canonical ids — the join key across books. */
  key: string;
  /** Whether both teams resolved to the canonical registry (false = matched on raw names only). */
  resolved: boolean;
  /** Earliest kickoff the books list. */
  startTime: string;
  status: GameStatus;
  away: PairTeam;
  home: PairTeam;
  games: Partial<Record<BookId, Game>>;
}

function pairTeam(t: Team): { team: PairTeam; resolved: boolean } {
  const c = canonicalTeam(t.name);
  if (c) {
    return {
      team: { id: c.id, name: `${c.city} ${c.nickname}`, color: t.color ?? c.color },
      resolved: true,
    };
  }
  return {
    team: { id: normalizeName(t.name), name: t.name, ...(t.color ? { color: t.color } : {}) },
    resolved: false,
  };
}

export function pairKeyOf(game: Game): {
  key: string;
  resolved: boolean;
  away: PairTeam;
  home: PairTeam;
} {
  const away = pairTeam(game.away);
  const home = pairTeam(game.home);
  return {
    key: `${away.team.id}@${home.team.id}`,
    resolved: away.resolved && home.resolved,
    away: away.team,
    home: home.team,
  };
}

function statusOf(games: Partial<Record<BookId, Game>>): GameStatus {
  const list = Object.values(games);
  if (list.some((g) => g.status === 'live')) return 'live';
  if (list.length > 0 && list.every((g) => g.status === 'finished')) return 'finished';
  return 'upcoming';
}

/**
 * Group games from any number of books into pairs: same canonical teams, kickoff within
 * tolerance, at most one game per book per pair. Single-book pairs are kept (the UI shows a dash
 * for the book that does not list the game).
 */
export function matchGames(games: Game[]): GamePair[] {
  const byKey = new Map<string, GamePair[]>();
  const pairs: GamePair[] = [];
  const sorted = [...games].sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (const g of sorted) {
    const k = pairKeyOf(g);
    const list = byKey.get(k.key) ?? [];
    let pair = list.find(
      (p) =>
        !p.games[g.book] &&
        Math.abs(Date.parse(p.startTime) - Date.parse(g.startTime)) <= KICKOFF_TOLERANCE_MS,
    );
    if (!pair) {
      pair = {
        key: k.key,
        resolved: k.resolved,
        startTime: g.startTime,
        status: 'upcoming',
        away: k.away,
        home: k.home,
        games: {},
      };
      list.push(pair);
      byKey.set(k.key, list);
      pairs.push(pair);
    }
    pair.games[g.book] = g;
    if (g.startTime < pair.startTime) pair.startTime = g.startTime;
    pair.status = statusOf(pair.games);
  }
  return pairs.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.key.localeCompare(b.key));
}

export interface PriceAtBook {
  line?: number;
  odds: Odds;
  suspended: boolean;
  updatedAt: string;
}

export interface SideComparison {
  side: SideKey;
  label: string;
  at: Partial<Record<BookId, PriceAtBook>>;
  /** All books that price this side quote the same line (always true for moneyline). */
  sameLine: boolean;
  /** The book paying the most for this side, when ≥ 2 books price it on the same line; null on a tie. */
  best: BookId | null;
  /** Decimal-odds gap between the best and the next best price (0 on a tie). */
  edge: number | null;
}

export interface MarketComparison {
  type: MarketType;
  sides: SideComparison[];
  /** Each book's hold on this market, as a fraction (1/d1 + 1/d2 − 1), when it prices both sides. */
  hold: Partial<Record<BookId, number>>;
}

const SIDES: Record<MarketType, SideKey[]> = {
  moneyline: ['away', 'home'],
  spread: ['away', 'home'],
  total: ['over', 'under'],
};

/** Implied probability of a decimal price (with the book's margin still in it). */
export function impliedProbability(decimal: number): number {
  return decimal > 0 ? 1 / decimal : 0;
}

export function compareMarket(pair: GamePair, type: MarketType): MarketComparison {
  const books = Object.keys(pair.games) as BookId[];
  const sides: SideComparison[] = [];
  for (const side of SIDES[type]) {
    const at: Partial<Record<BookId, PriceAtBook>> = {};
    let label: string = side;
    for (const book of books) {
      const market = pair.games[book]?.markets[type];
      const s = market?.sides[side];
      if (!market || !s) continue;
      at[book] = {
        ...(s.line !== undefined ? { line: s.line } : {}),
        odds: s.odds,
        suspended: market.suspended,
        updatedAt: s.updatedAt,
      };
      label = s.label;
    }
    const priced = (Object.entries(at) as [BookId, PriceAtBook][]).filter(([, p]) => !p.suspended);
    const lines = new Set(Object.values(at).map((p) => p.line));
    const sameLine = lines.size <= 1;
    let best: BookId | null = null;
    let edge: number | null = null;
    if (sameLine && priced.length >= 2) {
      const ranked = [...priced].sort((a, b) => b[1].odds.decimal - a[1].odds.decimal);
      const top = ranked[0]!;
      const next = ranked[1]!;
      edge = Math.round((top[1].odds.decimal - next[1].odds.decimal) * 1000) / 1000;
      best = edge > 0 ? top[0] : null;
    }
    sides.push({ side, label, at, sameLine, best, edge });
  }
  const hold: Partial<Record<BookId, number>> = {};
  for (const book of books) {
    const prices = sides.map((s) => s.at[book]).filter((p): p is PriceAtBook => !!p);
    if (prices.length === 2) {
      const h = prices.reduce((sum, p) => sum + impliedProbability(p.odds.decimal), 0) - 1;
      hold[book] = Math.round(h * 10000) / 10000;
    }
  }
  return { type, sides, hold };
}

/* ------------------------------------------------------------------------------------------------
 * Who moved first?
 * ---------------------------------------------------------------------------------------------- */

export interface BookMove extends OddsChange {
  book: BookId;
}

export interface PairedMove {
  /** pair key + market + side */
  key: string;
  market: MarketType;
  side: SideKey;
  first: BookMove;
  second: BookMove;
  /** second.at − first.at */
  leadMs: number;
}

export interface MovePairing {
  paired: PairedMove[];
  /** Moves that found no counterpart at another book inside the window. */
  unpaired: number;
  /** How many paired moves each book showed first. */
  leads: Record<BookId, number>;
  medianLeadMs: Record<BookId, number | null>;
}

/** Two moves are "the same move" when they land on the same line, or move the price the same way. */
export function sameDestination(a: OddsChange, b: OddsChange): boolean {
  if (a.field === 'line' || b.field === 'line') {
    return a.nextLine !== undefined && a.nextLine === b.nextLine;
  }
  if (!a.prevOdds || !b.prevOdds) return false;
  return (
    Math.sign(a.nextOdds.decimal - a.prevOdds.decimal) ===
    Math.sign(b.nextOdds.decimal - b.prevOdds.decimal)
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * Pair each move with the earliest same-destination move at a *different* book for the same
 * game/market/side inside `windowMs`. Greedy in time order, so a move is used at most once.
 *
 * `keyOf` maps a move to its cross-book game key (`pairKeyOf(game).key`), or undefined when the
 * game is unknown. Honest caveat for the reader: a poll-only book's `at` is when *we* saw the
 * change, bounded by its CDN cache, so a "lead" is about visibility, not about which trader moved.
 */
export function pairMoves(
  moves: BookMove[],
  keyOf: (m: BookMove) => string | undefined,
  windowMs = 120_000,
): MovePairing {
  const sorted = [...moves].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const open = new Map<string, BookMove[]>();
  const paired: PairedMove[] = [];
  let unpaired = 0;
  for (const m of sorted) {
    const gameKey = keyOf(m);
    if (!gameKey) {
      unpaired++;
      continue;
    }
    const key = `${gameKey}:${m.market}:${m.side}`;
    const candidates = open.get(key) ?? [];
    const at = Date.parse(m.at);
    const i = candidates.findIndex(
      (c) => c.book !== m.book && at - Date.parse(c.at) <= windowMs && sameDestination(c, m),
    );
    if (i >= 0) {
      const first = candidates[i]!;
      candidates.splice(i, 1);
      paired.push({
        key,
        market: m.market,
        side: m.side,
        first,
        second: m,
        leadMs: at - Date.parse(first.at),
      });
      continue;
    }
    candidates.push(m);
    open.set(key, candidates);
  }
  for (const list of open.values()) unpaired += list.length;
  const leads: Record<BookId, number> = { draftkings: 0, fanduel: 0 };
  const samples: Record<BookId, number[]> = { draftkings: [], fanduel: [] };
  for (const p of paired) {
    leads[p.first.book]++;
    samples[p.first.book].push(p.leadMs);
  }
  return {
    paired,
    unpaired,
    leads,
    medianLeadMs: { draftkings: median(samples.draftkings), fanduel: median(samples.fanduel) },
  };
}
