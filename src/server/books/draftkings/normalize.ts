import type {
  Game,
  GameStatus,
  LiveState,
  MarketType,
  Odds,
  SideKey,
  Team,
} from '../../../shared/types.js';
import type {
  GamePatch,
  GameUpsert,
  LeagueRef,
  NormalizedDelta,
  SelectionUpsert,
} from '../types.js';
import {
  DkEvent,
  DkIdRef,
  DkLeagueSnapshot,
  DkMarket,
  DkSelection,
  DkSubscriptionPartial,
  type DkEventT,
  type DkMarketT,
  type DkSelectionT,
  type DkSubscriptionPartialT,
  type DkUpdateFrameT,
} from './schema.js';

/* ------------------------------------------------------------------------------------------------
 * Odds helpers
 * ---------------------------------------------------------------------------------------------- */

/** DraftKings renders negative prices with U+2212 (MINUS SIGN), not ASCII '-'. */
export function parseAmerican(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\u2212/g, '-').replace(/\s+/g, '');
  if (!/^[+-]?\d+$/.test(cleaned)) return undefined;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

export function americanFromDecimal(decimal: number): number {
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return -Math.round(100 / (decimal - 1));
}

function decimalFromAmerican(american: number): number {
  const d = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  return Math.round(d * 1000) / 1000;
}

export function toOdds(sel: DkSelectionT): Odds | undefined {
  const decimalRaw =
    typeof sel.trueOdds === 'number' && sel.trueOdds > 1
      ? sel.trueOdds
      : sel.displayOdds?.decimal
        ? Number.parseFloat(sel.displayOdds.decimal)
        : undefined;
  const decimal =
    decimalRaw && Number.isFinite(decimalRaw) && decimalRaw > 1 ? decimalRaw : undefined;
  const americanRaw = parseAmerican(sel.displayOdds?.american);

  if (decimal !== undefined) {
    return {
      american: americanRaw ?? americanFromDecimal(decimal),
      decimal: Math.round(decimal * 1000) / 1000,
    };
  }
  if (americanRaw !== undefined) {
    return { american: americanRaw, decimal: decimalFromAmerican(americanRaw) };
  }
  return undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Entity mapping
 * ---------------------------------------------------------------------------------------------- */

const MARKET_BY_NAME: Record<string, MarketType> = {
  moneyline: 'moneyline',
  'money line': 'moneyline',
  spread: 'spread',
  'point spread': 'spread',
  'run line': 'spread',
  'puck line': 'spread',
  total: 'total',
  'total points': 'total',
  'total runs': 'total',
  'total goals': 'total',
};

/** DraftKings market ids are "<typeCode>_<offerId>": 1 = moneyline, 2 = spread, 3 = total. */
const MARKET_BY_ID_PREFIX: Record<string, MarketType> = {
  '1': 'moneyline',
  '2': 'spread',
  '3': 'total',
};

function marketTypeOf(market: DkMarketT): MarketType | undefined {
  const byName =
    MARKET_BY_NAME[(market.marketType?.name ?? market.name ?? '').trim().toLowerCase()];
  if (byName) return byName;
  const prefix = market.id.split('_')[0];
  return prefix ? MARKET_BY_ID_PREFIX[prefix] : undefined;
}

export function mapStatus(raw: string | undefined): GameStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'STARTED':
    case 'IN_PROGRESS':
    case 'LIVE':
      return 'live';
    case 'FINISHED':
    case 'ENDED':
    case 'COMPLETED':
    case 'CLOSED':
    case 'CANCELLED':
    case 'CANCELED':
    case 'ABANDONED':
    case 'POSTPONED':
      return 'finished';
    default:
      return 'upcoming';
  }
}

function shortNameOf(name: string, provided?: string): string {
  if (provided) return provided;
  const first = name.trim().split(/\s+/)[0];
  return first ? first.toUpperCase().slice(0, 4) : name;
}

function teamsOf(ev: DkEventT): { home: Team; away: Team } | undefined {
  const parts = ev.participants ?? [];
  const home = parts.find((p) => (p.venueRole ?? '').toLowerCase() === 'home');
  const away = parts.find((p) => (p.venueRole ?? '').toLowerCase() === 'away');
  if (home?.name && away?.name) {
    return {
      home: {
        id: home.id ?? `${ev.id}-home`,
        name: home.name,
        shortName: shortNameOf(home.name, home.metadata?.shortName),
        ...(home.metadata?.teamColor ? { color: home.metadata.teamColor } : {}),
      },
      away: {
        id: away.id ?? `${ev.id}-away`,
        name: away.name,
        shortName: shortNameOf(away.name, away.metadata?.shortName),
        ...(away.metadata?.teamColor ? { color: away.metadata.teamColor } : {}),
      },
    };
  }
  // Fallback: DraftKings names events "AWAY @ HOME".
  const m = /^(.+?)\s+@\s+(.+)$/.exec(ev.name ?? '');
  if (!m || !m[1] || !m[2]) return undefined;
  return {
    away: { id: `${ev.id}-away`, name: m[1].trim(), shortName: shortNameOf(m[1]) },
    home: { id: `${ev.id}-home`, name: m[2].trim(), shortName: shortNameOf(m[2]) },
  };
}

function liveOf(ev: DkEventT): LiveState | undefined {
  const state = ev.liveGameState;
  const score = ev.eventScorecard?.mainScorecard;
  if (!state && !score) return undefined;
  const live: LiveState = {};
  if (state?.period) live.period = state.period;
  if (typeof state?.isClockRunning === 'boolean') live.clockRunning = state.isClockRunning;
  // DraftKings lists the away team first (sortOrder 1) for North American sports.
  const first = score?.firstTeamScore !== undefined ? Number(score.firstTeamScore) : undefined;
  const second = score?.secondTeamScore !== undefined ? Number(score.secondTeamScore) : undefined;
  if (first !== undefined && Number.isFinite(first)) live.awayScore = first;
  if (second !== undefined && Number.isFinite(second)) live.homeScore = second;
  return live;
}

function isValidDate(iso: string | undefined): iso is string {
  return !!iso && Number.isFinite(Date.parse(iso));
}

function normalizeEvent(raw: unknown, at: string): GameUpsert | undefined {
  const parsed = DkEvent.safeParse(raw);
  if (!parsed.success) return undefined;
  const ev = parsed.data;
  if (!isValidDate(ev.startEventDate)) return undefined;
  const teams = teamsOf(ev);
  if (!teams) return undefined;
  const live = liveOf(ev);
  return {
    id: ev.id,
    startTime: new Date(ev.startEventDate).toISOString(),
    status: mapStatus(ev.status),
    home: teams.home,
    away: teams.away,
    ...(live ? { live } : {}),
    updatedAt: at,
  };
}

function patchFromEvent(raw: unknown): GamePatch | undefined {
  const parsed = DkEvent.safeParse(raw);
  if (!parsed.success) return undefined;
  const ev = parsed.data;
  const patch: GamePatch = { id: ev.id };
  if (ev.status !== undefined) patch.status = mapStatus(ev.status);
  if (isValidDate(ev.startEventDate)) patch.startTime = new Date(ev.startEventDate).toISOString();
  const live = liveOf(ev);
  if (live) patch.live = live;
  const teams = ev.participants?.length ? teamsOf(ev) : undefined;
  if (teams) {
    patch.home = teams.home;
    patch.away = teams.away;
  }
  return patch;
}

function sideKeyOf(
  sel: DkSelectionT,
  marketType: MarketType | undefined,
  teams?: { home: Team; away: Team },
): SideKey | undefined {
  const outcome = (sel.outcomeType ?? '').toLowerCase();
  if (outcome === 'home' || outcome === 'away' || outcome === 'over' || outcome === 'under')
    return outcome;
  const label = (sel.label ?? '').toLowerCase();
  if (marketType === 'total') {
    if (label.startsWith('over')) return 'over';
    if (label.startsWith('under')) return 'under';
    return undefined;
  }
  const pid = sel.participants?.[0]?.id;
  if (teams) {
    if (pid && pid === teams.home.id) return 'home';
    if (pid && pid === teams.away.id) return 'away';
    if (label && label === teams.home.name.toLowerCase()) return 'home';
    if (label && label === teams.away.name.toLowerCase()) return 'away';
  }
  return undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Snapshot
 * ---------------------------------------------------------------------------------------------- */

interface NormalizedSnapshot {
  games: Game[];
  leagueName?: string;
  subscriptionSpec?: DkSubscriptionPartialT;
  invalidEntities: number;
}

export function normalizeSnapshot(
  raw: unknown,
  league: LeagueRef,
  fetchedAt: string,
): NormalizedSnapshot {
  const root = DkLeagueSnapshot.parse(raw);
  let invalid = 0;

  const games = new Map<string, Game>();
  for (const rawEvent of root.events) {
    const up = normalizeEvent(rawEvent, fetchedAt);
    if (!up) {
      invalid++;
      continue;
    }
    games.set(up.id, {
      ...up,
      book: 'draftkings',
      league: league.id,
      markets: { moneyline: null, spread: null, total: null },
    });
  }

  const marketRefs = new Map<string, { gameId: string; type: MarketType }>();
  for (const rawMarket of root.markets) {
    const parsed = DkMarket.safeParse(rawMarket);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const m = parsed.data;
    const type = marketTypeOf(m);
    const game = m.eventId ? games.get(m.eventId) : undefined;
    if (!type || !game) {
      invalid++;
      continue;
    }
    // Belt and braces: the endpoint is already scoped to main lines, but never trust that.
    if (m.subcategoryId !== undefined && String(m.subcategoryId) !== league.subcategoryId) continue;
    if (m.main === false) continue;
    if (game.markets[type]) continue; // keep the first main market of each type
    game.markets[type] = {
      type,
      sides: {},
      suspended: m.isSuspended === true,
      updatedAt: fetchedAt,
      sourceMarketId: m.id,
    };
    marketRefs.set(m.id, { gameId: game.id, type });
  }

  for (const rawSel of root.selections) {
    const parsed = DkSelection.safeParse(rawSel);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const s = parsed.data;
    const ref = s.marketId ? marketRefs.get(s.marketId) : undefined;
    if (!ref) continue; // selection for a market we don't track (not an error)
    const game = games.get(ref.gameId)!;
    const market = game.markets[ref.type]!;
    const key = sideKeyOf(s, ref.type, { home: game.home, away: game.away });
    const odds = toOdds(s);
    if (!key || !odds) {
      invalid++;
      continue;
    }
    if (market.sides[key]) continue;
    market.sides[key] = {
      key,
      label: s.label ?? key,
      ...(typeof s.points === 'number' ? { line: s.points } : {}),
      odds,
      updatedAt: fetchedAt,
      sourceSelectionId: s.id,
    };
  }

  const partialKey = `league-events-${league.id}`;
  const partialRaw = root.subscriptionPartials?.[partialKey];
  const partial = partialRaw ? DkSubscriptionPartial.safeParse(partialRaw) : undefined;

  return {
    games: [...games.values()],
    leagueName: root.leagues?.[0]?.name,
    ...(partial?.success ? { subscriptionSpec: partial.data } : {}),
    invalidEntities: invalid,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Socket delta
 * ---------------------------------------------------------------------------------------------- */

function ids(list: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const item of list ?? []) {
    const p = DkIdRef.safeParse(item);
    if (p.success) out.push(p.data);
  }
  return out;
}

export function normalizeUpdateFrame(
  frame: DkUpdateFrameT,
  league: LeagueRef,
  receivedAt: string,
): NormalizedDelta {
  const body = frame.data.data;
  const createdAt =
    frame.data.metadata?.createdTime ?? frame.websocketPublishTimestamp ?? receivedAt;
  const publishedAt =
    frame.websocketPublishTimestamp ?? frame.data.metadata?.publishedTime ?? receivedAt;
  let invalid = 0;

  const delta: NormalizedDelta = {
    createdAt: new Date(createdAt).toISOString(),
    publishedAt: new Date(publishedAt).toISOString(),
    receivedAt,
    games: { upsert: [], patch: [], remove: ids(body.remove?.events) },
    markets: { upsert: [], patch: [], remove: ids(body.remove?.markets) },
    selections: { upsert: [], remove: ids(body.remove?.selections) },
    invalidEntities: 0,
  };

  for (const raw of body.add?.events ?? []) {
    const up = normalizeEvent(raw, delta.createdAt);
    if (up) delta.games.upsert.push(up);
    else invalid++;
  }
  for (const raw of body.change?.events ?? []) {
    const patch = patchFromEvent(raw);
    if (patch) delta.games.patch.push(patch);
    else invalid++;
  }

  const marketLists = [...(body.add?.markets ?? []), ...(body.change?.markets ?? [])];
  for (const raw of marketLists) {
    const parsed = DkMarket.safeParse(raw);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const m = parsed.data;
    const type = marketTypeOf(m);
    if (!m.eventId || !type) {
      // Partial change (e.g. {id, isSuspended}) — only meaningful if we already track the market.
      if (typeof m.isSuspended === 'boolean') {
        delta.markets.patch.push({ sourceMarketId: m.id, suspended: m.isSuspended });
      }
      continue;
    }
    if (m.subcategoryId !== undefined && String(m.subcategoryId) !== league.subcategoryId) continue;
    if (m.main === false) continue;
    delta.markets.upsert.push({
      sourceMarketId: m.id,
      gameId: m.eventId,
      type,
      ...(typeof m.isSuspended === 'boolean' ? { suspended: m.isSuspended } : {}),
    });
  }

  const selectionLists = [...(body.add?.selections ?? []), ...(body.change?.selections ?? [])];
  for (const raw of selectionLists) {
    const parsed = DkSelection.safeParse(raw);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const s = parsed.data;
    const odds = toOdds(s);
    if (!odds) {
      invalid++;
      continue;
    }
    const key = sideKeyOf(s, undefined);
    const up: SelectionUpsert = { sourceSelectionId: s.id, odds };
    if (s.marketId) up.sourceMarketId = s.marketId;
    if (s.replacedSelectionId) up.replacedSelectionId = s.replacedSelectionId;
    if (key) up.key = key;
    if (s.label) up.label = s.label;
    if (typeof s.points === 'number') up.line = s.points;
    delta.selections.upsert.push(up);
  }

  delta.invalidEntities = invalid;
  return delta;
}

export function defaultSubscriptionSpec(league: LeagueRef): DkSubscriptionPartialT {
  return {
    entity: 'events',
    query: `$filter=leagueId eq '${league.id}' and clientMetadata/Subcategories/any(s: s/Id eq '${league.subcategoryId}')&$orderBy=startEventDate asc`,
    includeMarkets: `$filter=tags/all(t: t ne 'SportcastBetBuilder') and clientMetadata/subCategoryId eq '${league.subcategoryId}'`,
  };
}
