import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OddsTable } from '../src/web/components/OddsTable.js';
import { displayState, StatusStrip } from '../src/web/components/StatusStrip.js';
import { initialState, reducer } from '../src/web/useOddsFeed.js';
import type { DeltaEvent, FeedMeta } from '../src/shared/types.js';
import { game, side, T0 } from './helpers.js';

const now = Date.now();
const meta = (over: Partial<FeedMeta> = {}): FeedMeta =>
  ({
    feedState: 'live',
    stale: false,
    lastContactAt: new Date(now - 3_000).toISOString(),
    lastChangeAt: null,
    lastSnapshotAt: new Date(now - 3_000).toISOString(),
    lastError: null,
    latency: { samples: 10, p50Ms: 120, p95Ms: 400 },
    ...over,
  }) as unknown as FeedMeta;

describe('OddsTable', () => {
  it('renders every side of every main market with lines and prices in the chosen format', () => {
    const g = game('g1');
    g.home = { id: 'h', name: 'DET Lions', shortName: 'DET' };
    g.away = { id: 'a', name: 'NO Saints', shortName: 'NO' };
    const html = renderToString(
      <OddsTable games={[g]} format="american" flashes={{}} serverNow={now} tzLabel="EDT" />,
    );
    expect(html).toContain('NO Saints');
    expect(html).toContain('DET Lions');
    expect(html).toContain('+150'); // away moneyline
    expect(html).toContain('-170'); // home moneyline
    expect(html).toContain('+3.5'); // away spread line
    expect(html).toContain('-3.5'); // home spread line
    expect(html).toContain('O 44.5');
    expect(html).toContain('U 44.5');
    const decimal = renderToString(
      <OddsTable games={[g]} format="decimal" flashes={{}} serverNow={now} tzLabel="EDT" />,
    );
    expect(decimal).toContain('2.50');
    expect(decimal).toContain('1.59');
    expect(decimal).not.toContain('+150');
  });

  it('shows a dash for a market DraftKings is not offering and dims a suspended one', () => {
    const g = game('g1');
    g.markets.total = null;
    g.markets.spread!.suspended = true;
    const html = renderToString(
      <OddsTable games={[g]} format="american" flashes={{}} serverNow={now} tzLabel="EDT" />,
    );
    expect(html).toContain('DraftKings is not offering this market');
    expect(html).toContain('odds-cell--suspended');
  });

  it('shows the previous price beside a fresh change and flashes the cell', () => {
    const g = game('g1');
    const home = side('home', -190, undefined, 'x');
    home.prev = {
      odds: { american: -170, decimal: 1.588 },
      changedAt: new Date(now - 5_000).toISOString(),
    };
    home.updatedAt = new Date(now - 5_000).toISOString();
    g.markets.moneyline!.sides.home = home;
    const html = renderToString(
      <OddsTable
        games={[g]}
        format="american"
        flashes={{ 'g1:moneyline:home': { kind: 'down', at: Date.now() } }}
        serverNow={now}
        tzLabel="EDT"
      />,
    );
    expect(html).toContain('odds-prev');
    expect(html).toContain('▼');
    expect(html).toContain('flash--down');
  });

  it('groups games by day and marks live games with the period and score', () => {
    const later = game('g2', { startTime: new Date(now + 3 * 24 * 3_600_000).toISOString() });
    const live = game('g1', {
      startTime: new Date(now - 3_600_000).toISOString(),
      status: 'live',
      live: { period: '3rd', homeScore: 17, awayScore: 10 },
    });
    const html = renderToString(
      <OddsTable
        games={[live, later]}
        format="american"
        flashes={{}}
        serverNow={now}
        tzLabel="EDT"
      />,
    );
    expect(html.match(/day-heading/g)).toHaveLength(2);
    // renderToString separates adjacent text nodes with <!-- -->, so match loosely
    expect(html).toMatch(/live-pill[^]*?LIVE[^]*?· 3rd/);
    expect(html).toContain('team-score">17');
    expect(html).toContain('team-score">10');
  });
});

describe('StatusStrip', () => {
  const props = {
    clockOffsetMs: 0,
    browserNow: now,
    browserLegP50: 5,
    refreshing: false,
    refreshNote: null,
    onRefresh: () => {},
    format: 'decimal' as const,
    onFormat: () => {},
  };

  it('names the state honestly for every feed condition', () => {
    expect(displayState(meta(), 'open').label).toBe('LIVE');
    expect(displayState(meta({ stale: true }), 'open')).toMatchObject({
      label: 'STALE',
      tone: 'bad',
    });
    expect(displayState(meta({ feedState: 'polling' }), 'open').label).toBe('POLLING');
    expect(displayState(meta({ feedState: 'degraded' }), 'open').tone).toBe('bad');
    expect(displayState(meta(), 'reconnecting').label).toBe('RECONNECTING');
    expect(displayState(null, 'connecting').label).toBe('CONNECTING');
  });

  it('shows contact age and end-to-end latency while live, and hides latency while polling', () => {
    const live = renderToString(<StatusStrip meta={meta()} connection="open" {...props} />);
    expect(live).toContain('3s ago');
    expect(live).toContain('125 ms'); // 120 ms server p50 + 5 ms browser leg
    const polling = renderToString(
      <StatusStrip meta={meta({ feedState: 'polling' })} connection="open" {...props} />,
    );
    expect(polling).toContain('n/a (polling)');
  });
});

describe('useOddsFeed reducer', () => {
  it('applies a delta: replaces games, records flashes, prepends moves with browser-leg latency', () => {
    const snap = reducer(initialState, {
      type: 'snapshot',
      snapshot: { version: 1, games: [game('g1')], meta: meta() },
      at: now,
    });
    expect(Object.keys(snap.games)).toEqual(['g1']);
    expect(snap.connection).toBe('open');

    const moved = game('g1');
    moved.markets.moneyline!.sides.home!.odds = { american: -200, decimal: 1.5 };
    const delta: DeltaEvent = {
      version: 2,
      games: [moved],
      removedGameIds: [],
      changes: [
        {
          gameId: 'g1',
          market: 'moneyline',
          side: 'home',
          field: 'odds',
          prevOdds: { american: -170, decimal: 1.588 },
          nextOdds: { american: -200, decimal: 1.5 },
          at: T0,
          source: 'socket',
        },
      ],
      meta: meta(),
      emittedAt: new Date(now - 40).toISOString(),
    };
    const next = reducer(snap, { type: 'delta', delta, at: now, offset: 0 });
    expect(next.version).toBe(2);
    expect(next.games.g1!.markets.moneyline!.sides.home!.odds.american).toBe(-200);
    expect(next.flashes['g1:moneyline:home']).toMatchObject({ kind: 'down' });
    expect(next.moves[0]).toMatchObject({ gameLabel: 'AWY @ HOM', serverToBrowserMs: 40 });
    expect(next.browserLegSamples).toEqual([40]);

    const gone = reducer(next, {
      type: 'delta',
      delta: { ...delta, version: 3, games: [], removedGameIds: ['g1'], changes: [] },
      at: now,
      offset: 0,
    });
    expect(gone.games.g1).toBeUndefined();
  });

  it('lets a heartbeat update staleness without touching the odds', () => {
    const snap = reducer(initialState, {
      type: 'snapshot',
      snapshot: { version: 1, games: [game('g1')], meta: meta() },
      at: now,
    });
    const beat = reducer(snap, {
      type: 'heartbeat',
      heartbeat: {
        serverTime: new Date().toISOString(),
        version: 1,
        feedState: 'polling',
        stale: true,
      },
      at: now,
    });
    expect(beat.meta?.stale).toBe(true);
    expect(beat.meta?.feedState).toBe('polling');
    expect(beat.games).toBe(snap.games);
  });
});
