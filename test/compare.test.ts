import { describe, expect, it } from 'vitest';
import {
  compareMarket,
  matchGames,
  pairKeyOf,
  pairMoves,
  sameDestination,
  type BookMove,
} from '../src/shared/compare.js';
import { canonicalTeam, NFL_TEAMS, normalizeName } from '../src/shared/teams.js';
import { game, KICKOFF } from './helpers.js';

describe('NFL team registry', () => {
  it('resolves every spelling the two books use to one canonical team', () => {
    const cases: Array<[string, string]> = [
      ['DET Lions', 'DET'],
      ['Detroit Lions', 'DET'],
      ['LA Chargers', 'LAC'],
      ['Los Angeles Chargers', 'LAC'],
      ['LA Rams', 'LAR'],
      ['L.A. Rams', 'LAR'],
      ['NY Jets', 'NYJ'],
      ['New York Jets', 'NYJ'],
      ['NY Giants', 'NYG'],
      ['WAS Commanders', 'WAS'],
      ['Washington Football Team', 'WAS'],
      ['San Francisco 49ers', 'SF'],
      ['SF 49ers', 'SF'],
      ['Bucs', 'TB'],
      ['TB Buccaneers', 'TB'],
      ['LV Raiders', 'LV'],
      ['jacksonville jaguars', 'JAX'],
      ['KC', 'KC'],
    ];
    for (const [name, id] of cases) expect(canonicalTeam(name)?.id, name).toBe(id);
    expect(canonicalTeam('Toronto Argonauts')).toBeUndefined();
    expect(canonicalTeam('New York')).toBeUndefined(); // ambiguous: never guess
    expect(canonicalTeam('')).toBeUndefined();
    expect(normalizeName('L.A.  Rams ')).toBe('l a rams');
  });

  it('has 32 teams with unique ids and unique nicknames', () => {
    expect(NFL_TEAMS).toHaveLength(32);
    expect(new Set(NFL_TEAMS.map((t) => t.id)).size).toBe(32);
    expect(new Set(NFL_TEAMS.map((t) => t.nickname.toLowerCase())).size).toBe(32);
  });
});

function dkGame(id: string, away: string, home: string, start = KICKOFF) {
  const g = game(id, { book: 'draftkings', startTime: start });
  g.away = { id: `${id}-a`, name: away, shortName: away.slice(0, 3) };
  g.home = { id: `${id}-h`, name: home, shortName: home.slice(0, 3) };
  return g;
}
function fdGame(id: string, away: string, home: string, start = KICKOFF) {
  const g = dkGame(id, away, home, start);
  g.book = 'fanduel';
  return g;
}

describe('matchGames', () => {
  it('pairs the same game across books despite different spellings and a one-minute kickoff gap', () => {
    const dk = dkGame('dk1', 'NO Saints', 'DET Lions');
    const fd = fdGame(
      'fd1',
      'New Orleans Saints',
      'Detroit Lions',
      new Date(Date.parse(KICKOFF) + 60_000).toISOString(),
    );
    const pairs = matchGames([fd, dk]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      key: 'NO@DET',
      resolved: true,
      startTime: KICKOFF, // the earliest listed
      away: { id: 'NO', name: 'New Orleans Saints', color: '#D3BC8D' },
      home: { id: 'DET', name: 'Detroit Lions' },
    });
    expect(pairs[0]!.games.draftkings?.id).toBe('dk1');
    expect(pairs[0]!.games.fanduel?.id).toBe('fd1');
    expect(pairKeyOf(dk).key).toBe(pairKeyOf(fd).key);
  });

  it('keeps single-book games, separates the same matchup a week apart, and never merges two of one book', () => {
    const weekLater = new Date(Date.parse(KICKOFF) + 7 * 24 * 3_600_000).toISOString();
    const pairs = matchGames([
      dkGame('dk1', 'NO Saints', 'DET Lions'),
      dkGame('dk2', 'NO Saints', 'DET Lions', weekLater),
      fdGame('fd2', 'New Orleans Saints', 'Detroit Lions', weekLater),
      dkGame('dk3', 'CHI Bears', 'GB Packers'),
    ]);
    expect(pairs.map((p) => `${p.key}:${Object.keys(p.games).sort().join('+')}`)).toEqual([
      'CHI@GB:draftkings',
      'NO@DET:draftkings',
      'NO@DET:draftkings+fanduel',
    ]);
  });

  it('falls back to raw names for teams outside the registry and says so', () => {
    const pairs = matchGames([
      dkGame('dk1', 'TOR Argonauts', 'OTT Redblacks'),
      fdGame('fd1', 'TOR Argonauts', 'OTT Redblacks'),
      fdGame('fd2', 'Toronto Argonauts', 'Ottawa Redblacks'),
    ]);
    expect(pairs.map((p) => `${p.resolved}:${Object.keys(p.games).length}`).sort()).toEqual([
      'false:1',
      'false:2',
    ]);
  });

  it('marks a pair live when either book says so', () => {
    const dk = dkGame('dk1', 'NO Saints', 'DET Lions');
    const fd = fdGame('fd1', 'New Orleans Saints', 'Detroit Lions');
    fd.status = 'live';
    expect(matchGames([dk, fd])[0]!.status).toBe('live');
  });
});

describe('compareMarket', () => {
  const dk = dkGame('dk1', 'NO Saints', 'DET Lions');
  const fd = fdGame('fd1', 'New Orleans Saints', 'Detroit Lions');

  it('finds the best price per side, the edge, and each book`s hold', () => {
    fd.markets.moneyline!.sides.home!.odds = { american: -165, decimal: 1.606 };
    fd.markets.moneyline!.sides.away!.odds = { american: 145, decimal: 2.45 };
    const cmp = compareMarket(matchGames([dk, fd])[0]!, 'moneyline');
    const home = cmp.sides.find((s) => s.side === 'home')!;
    const away = cmp.sides.find((s) => s.side === 'away')!;
    expect(home).toMatchObject({ best: 'fanduel', edge: 0.018, sameLine: true });
    expect(away).toMatchObject({ best: 'draftkings', edge: 0.05 });
    expect(cmp.hold.draftkings).toBeCloseTo(1 / 2.5 + 1 / 1.588 - 1, 3);
    expect(cmp.hold.fanduel).toBeCloseTo(1 / 2.45 + 1 / 1.606 - 1, 3);
  });

  it('refuses to call a best price across different lines, ties or suspended markets', () => {
    const fd2 = fdGame('fd2', 'New Orleans Saints', 'Detroit Lions');
    fd2.markets.spread!.sides.home!.line = -4;
    fd2.markets.spread!.sides.home!.odds = { american: 100, decimal: 2 };
    const spread = compareMarket(matchGames([dk, fd2])[0]!, 'spread');
    expect(spread.sides.find((s) => s.side === 'home')).toMatchObject({
      sameLine: false,
      best: null,
      edge: null,
    });
    const total = compareMarket(matchGames([dk, fd2])[0]!, 'total');
    expect(total.sides[0]).toMatchObject({ sameLine: true, best: null, edge: 0 }); // identical prices

    fd2.markets.moneyline!.suspended = true;
    fd2.markets.moneyline!.sides.home!.odds = { american: 100, decimal: 2 };
    const ml = compareMarket(matchGames([dk, fd2])[0]!, 'moneyline');
    expect(ml.sides.find((s) => s.side === 'home')!.best).toBeNull(); // only one live price
  });

  it('reports a side a book does not price as absent', () => {
    const fd3 = fdGame('fd3', 'New Orleans Saints', 'Detroit Lions');
    fd3.markets.total = null;
    const cmp = compareMarket(matchGames([dk, fd3])[0]!, 'total');
    expect(cmp.sides[0]!.at.fanduel).toBeUndefined();
    expect(cmp.sides[0]!.at.draftkings).toBeDefined();
    expect(cmp.hold.fanduel).toBeUndefined();
  });
});

describe('pairMoves', () => {
  const t0 = Date.parse('2026-09-20T17:30:00Z');
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  const lineMove = (book: BookMove['book'], gameId: string, when: number, next = -4): BookMove => ({
    book,
    gameId,
    market: 'spread',
    side: 'home',
    field: 'line',
    prevLine: -3.5,
    nextLine: next,
    prevOdds: { american: -110, decimal: 1.909 },
    nextOdds: { american: -110, decimal: 1.909 },
    at: at(when),
    source: book === 'draftkings' ? 'socket' : 'snapshot',
  });
  const oddsMove = (
    book: BookMove['book'],
    gameId: string,
    when: number,
    from: number,
    to: number,
  ): BookMove => ({
    book,
    gameId,
    market: 'moneyline',
    side: 'home',
    field: 'odds',
    prevOdds: { american: from, decimal: from < 0 ? 1 + 100 / -from : 1 + from / 100 },
    nextOdds: { american: to, decimal: to < 0 ? 1 + 100 / -to : 1 + to / 100 },
    at: at(when),
    source: 'socket',
  });
  const keyOf = (m: BookMove) => (m.gameId === 'x' ? undefined : 'NO@DET');

  it('pairs the same line move at two books, in either order, inside the window', () => {
    const result = pairMoves(
      [
        lineMove('fanduel', 'fd1', 40_000),
        lineMove('draftkings', 'dk1', 12_000),
        oddsMove('draftkings', 'dk1', 100_000, -170, -180),
        oddsMove('fanduel', 'fd1', 90_000, -165, -175),
      ],
      keyOf,
    );
    expect(result.paired).toHaveLength(2);
    expect(result.paired[0]).toMatchObject({
      first: { book: 'draftkings' },
      second: { book: 'fanduel' },
      leadMs: 28_000,
    });
    expect(result.paired[1]).toMatchObject({ first: { book: 'fanduel' }, leadMs: 10_000 });
    expect(result.leads).toEqual({ draftkings: 1, fanduel: 1 });
    expect(result.medianLeadMs).toEqual({ draftkings: 28_000, fanduel: 10_000 });
    expect(result.unpaired).toBe(0);
  });

  it('does not pair different destinations, opposite directions, the same book, or moves too far apart', () => {
    const result = pairMoves(
      [
        lineMove('draftkings', 'dk1', 0, -4),
        lineMove('fanduel', 'fd1', 10_000, -4.5), // different line
        lineMove('draftkings', 'dk1', 20_000, -4), // same book again
        oddsMove('draftkings', 'dk1', 30_000, -170, -180),
        oddsMove('fanduel', 'fd1', 31_000, -170, -160), // opposite direction
        lineMove('fanduel', 'fd1', 200_000, -4), // 180 s after the last DK -4: outside the window
        lineMove('fanduel', 'x', 5_000), // unknown game
      ],
      keyOf,
      120_000,
    );
    expect(result.paired).toHaveLength(0);
    expect(result.unpaired).toBe(7);
    expect(
      sameDestination(lineMove('draftkings', 'a', 0, -4), lineMove('fanduel', 'b', 0, -4)),
    ).toBe(true);
    expect(
      sameDestination(
        oddsMove('draftkings', 'a', 0, -170, -180),
        oddsMove('fanduel', 'b', 0, -165, -175),
      ),
    ).toBe(true);
    expect(
      sameDestination(
        oddsMove('draftkings', 'a', 0, -170, -180),
        oddsMove('fanduel', 'b', 0, -170, -160),
      ),
    ).toBe(false);
  });

  it('uses each move at most once', () => {
    const result = pairMoves(
      [
        lineMove('draftkings', 'dk1', 0),
        lineMove('fanduel', 'fd1', 5_000),
        lineMove('fanduel', 'fd1', 6_000),
      ],
      keyOf,
    );
    expect(result.paired).toHaveLength(1);
    expect(result.unpaired).toBe(1);
  });
});
