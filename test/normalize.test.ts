import { describe, expect, it } from 'vitest';
import {
  americanFromDecimal,
  defaultSubscriptionSpec,
  mapStatus,
  normalizeSnapshot,
  normalizeUpdateFrame,
  parseAmerican,
  toOdds,
} from '../src/server/books/draftkings/normalize.js';
import { DkUpdateFrame } from '../src/server/books/draftkings/schema.js';
import { clone, fixture } from './helpers.js';

const NFL = { id: '88808', name: 'NFL', subcategoryId: '4518' };
const MLB = { id: '84240', name: 'MLB', subcategoryId: '4519' };
const AT = '2026-09-13T01:00:00.000Z';

type Frames = { frames: Record<string, unknown> };

describe('odds parsing', () => {
  it('handles the Unicode minus DraftKings emits', () => {
    expect(parseAmerican('−110')).toBe(-110);
    expect(parseAmerican('-110')).toBe(-110);
    expect(parseAmerican('+260')).toBe(260);
    expect(parseAmerican('EVEN')).toBeUndefined();
    expect(parseAmerican(undefined)).toBeUndefined();
  });

  it('derives american odds from decimal when the display string is missing', () => {
    expect(americanFromDecimal(3.6)).toBe(260);
    expect(americanFromDecimal(1.30769231)).toBe(-325);
    expect(americanFromDecimal(2)).toBe(100);
  });

  it('prefers trueOdds and rounds to three decimals', () => {
    expect(
      toOdds({ id: 'x', trueOdds: 1.90909091, displayOdds: { american: '−110', decimal: '1.90' } }),
    ).toEqual({
      american: -110,
      decimal: 1.909,
    });
    expect(toOdds({ id: 'x', displayOdds: { american: '+150' } })).toEqual({
      american: 150,
      decimal: 2.5,
    });
    expect(toOdds({ id: 'x' })).toBeUndefined();
    expect(toOdds({ id: 'x', trueOdds: 0.5 })).toBeUndefined();
  });

  it('maps DraftKings event statuses', () => {
    expect(mapStatus('NOT_STARTED')).toBe('upcoming');
    expect(mapStatus('STARTED')).toBe('live');
    expect(mapStatus('FINISHED')).toBe('finished');
    expect(mapStatus('SOMETHING_NEW')).toBe('upcoming');
  });
});

describe('normalizeSnapshot (real NFL payload)', () => {
  const raw = fixture('dk-league-88808.json');

  it('maps every event to a game with all three main markets', () => {
    const { games, invalidEntities, subscriptionSpec, leagueName } = normalizeSnapshot(
      raw,
      NFL,
      AT,
    );
    expect(games).toHaveLength(75);
    expect(invalidEntities).toBe(0);
    expect(leagueName).toBe('NFL');
    for (const g of games) {
      expect(g.markets.moneyline?.sides.home).toBeDefined();
      expect(g.markets.moneyline?.sides.away).toBeDefined();
      expect(g.markets.spread?.sides.home?.line).toBeTypeOf('number');
      expect(g.markets.spread?.sides.away?.line).toBeTypeOf('number');
      expect(g.markets.total?.sides.over?.line).toBe(g.markets.total?.sides.under?.line);
      expect(g.status).toBe('upcoming');
      expect(Number.isFinite(Date.parse(g.startTime))).toBe(true);
    }
    expect(subscriptionSpec?.entity).toBe('events');
    expect(subscriptionSpec?.query).toContain("leagueId eq '88808'");
  });

  it('assigns sides from outcomeType and keeps spread lines signed per side', () => {
    const { games } = normalizeSnapshot(raw, NFL, AT);
    const g = games.find((x) => x.id === '34118210')!; // NO Saints @ DET Lions
    expect(g.away.shortName).toBe('NO');
    expect(g.home.shortName).toBe('DET');
    expect(g.markets.moneyline!.sides.home!.odds).toEqual({ american: -325, decimal: 1.308 });
    expect(g.markets.moneyline!.sides.away!.odds.american).toBe(260);
    expect(g.markets.spread!.sides.home!.line).toBe(-7);
    expect(g.markets.spread!.sides.away!.line).toBe(7);
    expect(g.markets.total!.sides.over!.line).toBe(49.5);
    expect(g.markets.total!.sides.over!.label).toBe('Over');
  });

  it('drops malformed entities without failing the payload', () => {
    const broken = clone(raw) as { events: unknown[]; markets: unknown[]; selections: unknown[] };
    broken.events.push({ id: 'no-date' }, null, 42);
    broken.markets.push(
      { id: '9_1', eventId: 'missing-event', name: 'Spread' },
      { nonsense: true },
    );
    broken.selections.push({
      id: 'bad',
      marketId: '2_84695643',
      outcomeType: 'Home' /* no odds */,
    });
    const { games, invalidEntities } = normalizeSnapshot(broken, NFL, AT);
    expect(games).toHaveLength(75);
    expect(invalidEntities).toBeGreaterThanOrEqual(4);
  });

  it('ignores markets outside the main-lines subcategory', () => {
    const alt = clone(raw) as { markets: Array<Record<string, unknown>> };
    alt.markets.push({ id: '2_999', eventId: '34118210', name: 'Spread', subcategoryId: 9999 });
    const { games } = normalizeSnapshot(alt, NFL, AT);
    expect(games.find((g) => g.id === '34118210')!.markets.spread!.sourceMarketId).toBe(
      '2_84695643',
    );
  });

  it('falls back to the "AWAY @ HOME" event name when participants are missing', () => {
    const res = normalizeSnapshot(
      {
        events: [{ id: '1', name: 'NO Saints @ DET Lions', startEventDate: AT }],
        markets: [],
        selections: [],
      },
      NFL,
      AT,
    );
    expect(res.games[0]!.away.name).toBe('NO Saints');
    expect(res.games[0]!.home.name).toBe('DET Lions');
  });
});

describe('normalizeUpdateFrame (real socket frames)', () => {
  const { frames } = fixture<Frames>('dk-socket-frames.json');
  const parse = (name: string) => DkUpdateFrame.parse(frames[name]);

  it('turns a selection change into an upsert without a market id', () => {
    const delta = normalizeUpdateFrame(parse('selectionChange'), MLB, AT);
    expect(delta.selections.upsert).toHaveLength(1);
    const up = delta.selections.upsert[0]!;
    expect(up.sourceMarketId).toBeUndefined();
    expect(up.odds.american).toBe(-112);
    expect(up.odds.decimal).toBe(1.893);
    expect(delta.createdAt).not.toBe(AT);
    expect(Date.parse(delta.publishedAt)).toBeGreaterThanOrEqual(Date.parse(delta.createdAt));
  });

  it('keeps replacedSelectionId and marketId on an added selection (line move)', () => {
    const delta = normalizeUpdateFrame(parse('add'), MLB, AT);
    const up = delta.selections.upsert[0]!;
    expect(up.replacedSelectionId).toBe('0OU86275332U1050_3');
    expect(up.sourceMarketId).toBe('3_86275332');
    expect(up.key).toBe('under');
    expect(up.line).toBe(11.5);
  });

  it('maps bare ids in remove lists', () => {
    const delta = normalizeUpdateFrame(parse('remove'), MLB, AT);
    expect(delta.selections.remove).toEqual(['0HC86275332N750_1']);
  });

  it('turns {id, isSuspended} market changes into patches', () => {
    const delta = normalizeUpdateFrame(parse('marketChange'), MLB, AT);
    expect(delta.markets.patch).toEqual([{ sourceMarketId: '1_86275334', suspended: true }]);
    expect(delta.markets.upsert).toHaveLength(0);
  });

  it('extracts status and live score from an event change', () => {
    const delta = normalizeUpdateFrame(parse('eventChange'), MLB, AT);
    expect(delta.games.patch).toHaveLength(1);
    const patch = delta.games.patch[0]!;
    expect(patch.status).toBe('live');
    expect(patch.live?.period).toBeTypeOf('string');
    expect(patch.live?.homeScore).toBeTypeOf('number');
  });
});

describe('defaultSubscriptionSpec', () => {
  it('matches the query DraftKings publishes in subscriptionPartials', () => {
    const raw = fixture<{
      subscriptionPartials: Record<string, { query: string; includeMarkets: string }>;
    }>('dk-league-88808.json');
    const spec = defaultSubscriptionSpec(NFL);
    expect(spec.query).toBe(raw.subscriptionPartials['league-events-88808']!.query);
    expect(spec.includeMarkets).toBe(
      raw.subscriptionPartials['league-events-88808']!.includeMarkets,
    );
  });
});
