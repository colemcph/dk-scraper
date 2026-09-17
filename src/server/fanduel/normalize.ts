import { americanFromDecimal, decimalFromAmerican, roundDecimal } from '../../shared/odds.js';
import { canonicalTeam } from '../../shared/teams.js';
import type { Game, Market, MarketType, Odds, SideKey, Team } from '../../shared/types.js';
import type { LeagueRef } from '../book.js';
import { FdEvent, FdMarket, FdPage, FdRunner, type FdMarketT, type FdRunnerT } from './schema.js';

/* ------------------------------------------------------------------------------------------------
 * Odds helpers
 * ---------------------------------------------------------------------------------------------- */

/** FanDuel gives both formats as numbers; decimal is the source of truth, american the display. */
export function toOdds(runner: FdRunnerT): Odds | undefined {
  const decimalRaw = runner.winRunnerOdds?.trueOdds?.decimalOdds?.decimalOdds;
  const americanRaw = runner.winRunnerOdds?.americanDisplayOdds?.americanOdds;
  const decimal =
    typeof decimalRaw === 'number' && Number.isFinite(decimalRaw) && decimalRaw > 1
      ? decimalRaw
      : undefined;
  const american =
    typeof americanRaw === 'number' && Number.isInteger(americanRaw) && americanRaw !== 0
      ? americanRaw
      : undefined;
  if (decimal !== undefined) {
    return { american: american ?? americanFromDecimal(decimal), decimal: roundDecimal(decimal) };
  }
  if (american !== undefined) return { american, decimal: decimalFromAmerican(american) };
  return undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Entity mapping
 * ---------------------------------------------------------------------------------------------- */

const MARKET_BY_TYPE: Record<string, MarketType> = {
  MONEY_LINE: 'moneyline',
  'MATCH_HANDICAP_(2-WAY)': 'spread',
  'TOTAL_POINTS_(OVER/UNDER)': 'total',
};

const MARKET_BY_NAME: Record<string, MarketType> = {
  moneyline: 'moneyline',
  'money line': 'moneyline',
  spread: 'spread',
  'point spread': 'spread',
  total: 'total',
  'total points': 'total',
};

export function marketTypeOf(market: FdMarketT): MarketType | undefined {
  const byType = market.marketType ? MARKET_BY_TYPE[market.marketType.toUpperCase()] : undefined;
  if (byType) return byType;
  return MARKET_BY_NAME[(market.marketName ?? '').trim().toLowerCase()];
}

function shortNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first ? first.toUpperCase().slice(0, 4) : name;
}

/** "Detroit Lions" -> canonical id/colour when known, so the two books line up in the UI. */
function teamOf(name: string, fallbackId: string): Team {
  const c = canonicalTeam(name);
  return {
    id: c?.id ?? fallbackId,
    name,
    shortName: c?.id ?? shortNameOf(name),
    ...(c ? { color: c.color } : {}),
  };
}

/** FanDuel names games "AWAY @ HOME"; futures and specials have plain names and are skipped. */
export function teamsOf(
  eventName: string,
  eventId: string,
): { home: Team; away: Team } | undefined {
  const m = /^(.+?)\s+@\s+(.+)$/.exec(eventName);
  if (!m || !m[1] || !m[2]) return undefined;
  return {
    away: teamOf(m[1].trim(), `${eventId}-away`),
    home: teamOf(m[2].trim(), `${eventId}-home`),
  };
}

function sideKeyOf(runner: FdRunnerT, type: MarketType, game: Game): SideKey | undefined {
  const result = (runner.result?.type ?? '').toUpperCase();
  if (result === 'HOME' || result === 'AWAY' || result === 'OVER' || result === 'UNDER') {
    return result.toLowerCase() as SideKey;
  }
  const name = (runner.runnerName ?? '').trim();
  if (type === 'total') {
    const lower = name.toLowerCase();
    if (lower.startsWith('over')) return 'over';
    if (lower.startsWith('under')) return 'under';
    return undefined;
  }
  const c = canonicalTeam(name);
  if (c && c.id === game.home.id) return 'home';
  if (c && c.id === game.away.id) return 'away';
  if (name && name === game.home.name) return 'home';
  if (name && name === game.away.name) return 'away';
  return undefined;
}

function isValidDate(iso: string | undefined): iso is string {
  return !!iso && Number.isFinite(Date.parse(iso));
}

/* ------------------------------------------------------------------------------------------------
 * Page snapshot
 * ---------------------------------------------------------------------------------------------- */

export interface NormalizedFdPage {
  games: Game[];
  invalidEntities: number;
}

/**
 * The page is a full picture every time (a poll transport has no deltas): every game event, its
 * three main markets, their runners. Non-game events (futures, specials) and the dozens of other
 * market types on the page are expected and ignored without being counted as invalid.
 */
export function normalizeFanDuelPage(
  raw: unknown,
  league: LeagueRef,
  fetchedAt: string,
): NormalizedFdPage {
  const root = FdPage.parse(raw);
  let invalid = 0;

  const games = new Map<string, Game>();
  for (const rawEvent of Object.values(root.attachments.events)) {
    const parsed = FdEvent.safeParse(rawEvent);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const ev = parsed.data;
    if (!ev.name || !ev.name.includes(' @ ')) continue; // futures / specials
    if (!isValidDate(ev.openDate)) {
      invalid++;
      continue;
    }
    const teams = teamsOf(ev.name, ev.eventId);
    if (!teams) {
      invalid++;
      continue;
    }
    games.set(ev.eventId, {
      id: ev.eventId,
      book: 'fanduel',
      league: league.id,
      startTime: new Date(ev.openDate).toISOString(),
      status: ev.inPlay ? 'live' : 'upcoming',
      home: teams.home,
      away: teams.away,
      markets: { moneyline: null, spread: null, total: null },
      updatedAt: fetchedAt,
    });
  }

  for (const rawMarket of Object.values(root.attachments.markets)) {
    const parsed = FdMarket.safeParse(rawMarket);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const m = parsed.data;
    const type = marketTypeOf(m);
    const game = m.eventId ? games.get(m.eventId) : undefined;
    if (!type || !game) continue; // another market type, or a futures market
    const status = (m.marketStatus ?? 'OPEN').toUpperCase();
    if (status !== 'OPEN' && status !== 'SUSPENDED') continue; // CLOSED etc. = not offered
    if (m.inPlay) game.status = 'live';
    if (game.markets[type]) continue; // keep the first main market of each type

    const market: Market = {
      type,
      sides: {},
      suspended: status === 'SUSPENDED',
      updatedAt: fetchedAt,
      sourceMarketId: m.marketId,
    };
    for (const rawRunner of m.runners) {
      const r = FdRunner.safeParse(rawRunner);
      if (!r.success) {
        invalid++;
        continue;
      }
      const runner = r.data;
      const runnerStatus = (runner.runnerStatus ?? 'ACTIVE').toUpperCase();
      if (runnerStatus !== 'ACTIVE' && runnerStatus !== 'SUSPENDED') continue;
      if (runnerStatus === 'SUSPENDED') market.suspended = true;
      const key = sideKeyOf(runner, type, game);
      const odds = toOdds(runner);
      const line = type === 'moneyline' ? undefined : runner.handicap;
      if (!key || !odds || (type !== 'moneyline' && typeof line !== 'number')) {
        invalid++;
        continue;
      }
      if (market.sides[key]) continue;
      market.sides[key] = {
        key,
        label:
          type === 'total'
            ? key === 'over'
              ? 'Over'
              : 'Under'
            : (runner.nameAbbr ?? runner.runnerName ?? key),
        ...(line !== undefined ? { line } : {}),
        odds,
        updatedAt: fetchedAt,
        // selectionId repeats across a team's markets; the market id makes it unique.
        sourceSelectionId: `${m.marketId}:${runner.selectionId}`,
      };
    }
    game.markets[type] = market;
  }

  // A game past kickoff with nothing offered and no in-play flag is over as far as this page knows.
  const now = Date.parse(fetchedAt);
  for (const game of games.values()) {
    const offered = Object.values(game.markets).some((m) => m !== null);
    if (game.status !== 'live' && !offered && Date.parse(game.startTime) < now) {
      game.status = 'finished';
    }
  }

  return { games: [...games.values()], invalidEntities: invalid };
}
