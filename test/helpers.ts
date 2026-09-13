import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Game, Market, MarketType, Side, SideKey } from '../src/shared/types.js';
import type { NormalizedDelta } from '../src/server/books/types.js';

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(resolve(__dirname, '..', 'fixtures', name), 'utf8')) as T;
}

export const T0 = '2026-09-13T01:00:00.000Z';

export function side(key: SideKey, american: number, line?: number, id?: string): Side {
  const decimal = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  return {
    key,
    label: key,
    ...(line !== undefined ? { line } : {}),
    odds: { american, decimal: Math.round(decimal * 1000) / 1000 },
    updatedAt: T0,
    sourceSelectionId: id ?? `sel-${key}-${american}-${line ?? 'ml'}`,
  };
}

export function market(type: MarketType, sides: Side[], id = `mkt-${type}`): Market {
  const map: Partial<Record<SideKey, Side>> = {};
  for (const s of sides) map[s.key] = s;
  return { type, sides: map, suspended: false, updatedAt: T0, sourceMarketId: id };
}

export function game(id: string, overrides: Partial<Game> = {}): Game {
  return {
    id,
    book: 'draftkings',
    league: '88808',
    startTime: '2026-09-13T17:00:00.000Z',
    status: 'upcoming',
    home: { id: `${id}-h`, name: 'Home Team', shortName: 'HOM' },
    away: { id: `${id}-a`, name: 'Away Team', shortName: 'AWY' },
    markets: {
      moneyline: market(
        'moneyline',
        [side('away', 150, undefined, `${id}-ml-a`), side('home', -170, undefined, `${id}-ml-h`)],
        `${id}-ml`,
      ),
      spread: market(
        'spread',
        [side('away', -110, 3.5, `${id}-sp-a`), side('home', -110, -3.5, `${id}-sp-h`)],
        `${id}-sp`,
      ),
      total: market(
        'total',
        [side('over', -110, 44.5, `${id}-t-o`), side('under', -110, 44.5, `${id}-t-u`)],
        `${id}-t`,
      ),
    },
    updatedAt: T0,
    ...overrides,
  };
}

export function emptyDelta(at = '2026-09-13T01:00:05.000Z'): NormalizedDelta {
  return {
    createdAt: at,
    publishedAt: at,
    receivedAt: at,
    games: { upsert: [], patch: [], remove: [] },
    markets: { upsert: [], patch: [], remove: [] },
    selections: { upsert: [], remove: [] },
    invalidEntities: 0,
  };
}

/** Deep clone so tests can mutate fixtures freely. */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
