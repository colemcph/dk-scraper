import { renderToString as reactRenderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { matchGames } from '../src/shared/compare.js';
import { CompareTable } from '../src/web/components/CompareTable.js';
import { LatencyPanel } from '../src/web/components/LatencyPanel.js';
import { LeadTracker } from '../src/web/components/LeadTracker.js';
import { OddsTable } from '../src/web/components/OddsTable.js';
import { displayState, freshnessBoundMs, StatusStrip } from '../src/web/components/StatusStrip.js';
import { initialState, reducer, type RecentMove } from '../src/web/useOddsFeed.js';
import type { DeltaEvent, FeedCounters, FeedMeta, LatencyStats } from '../src/shared/types.js';
import { game, side, T0 } from './helpers.js';

/** React separates adjacent text nodes with `<!-- -->`; strip them so assertions read like the page. */
const renderToString = (el: Parameters<typeof reactRenderToString>[0]) =>
  reactRenderToString(el).replace(/<!-- -->/g, '');

const now = Date.now();
const meta = (over: Partial<FeedMeta> = {}): FeedMeta =>
  ({
    book: 'draftkings',
    bookName: 'DraftKings',
    transport: 'push',
    feedState: 'live',
    stale: false,
    lastContactAt: new Date(now - 3_000).toISOString(),
    lastChangeAt: null,
    lastSnapshotAt: new Date(now - 3_000).toISOString(),
    lastError: null,
    latency: { samples: 10, p50Ms: 120, p95Ms: 400 },
    poll: null,
    ...over,
  }) as unknown as FeedMeta;

const fdMeta = (over: Partial<FeedMeta> = {}): FeedMeta =>
  meta({
    book: 'fanduel',
    bookName: 'FanDuel',
    transport: 'poll',
    feedState: 'polling',
    latency: { samples: 0, p50Ms: null, p95Ms: null } as unknown as FeedMeta['latency'],
    poll: {
      intervalMs: 1_000,
      suggestedIntervalMs: 18_000,
      bypassCache: false,
      p50Ms: 14,
      lastMs: 12,
      cacheMaxAgeMs: 30_000,
      lastAgeMs: 12_000,
      lastCacheHit: true,
      generatedAt: new Date(now - 12_000).toISOString(),
      lastPollAt: new Date(now - 1_000).toISOString(),
      lastStatus: 304,
      etag: 'W/"abc"',
    },
    ...over,
  });

const table = (g: ReturnType<typeof game>, format: 'american' | 'decimal' = 'american') =>
  renderToString(
    <OddsTable
      book="draftkings"
      games={[g]}
      format={format}
      flashes={{}}
      serverNow={now}
      tzLabel="EDT"
    />,
  );

describe('OddsTable', () => {
  it('renders every side of every main market with lines and prices in the chosen format', () => {
    const g = game('g1');
    g.home = { id: 'h', name: 'DET Lions', shortName: 'DET' };
    g.away = { id: 'a', name: 'NO Saints', shortName: 'NO' };
    const html = table(g);
    expect(html).toContain('NO Saints');
    expect(html).toContain('DET Lions');
    expect(html).toContain('+150'); // away moneyline
    expect(html).toContain('-170'); // home moneyline
    expect(html).toContain('+3.5'); // away spread line
    expect(html).toContain('-3.5'); // home spread line
    expect(html).toContain('O 44.5');
    expect(html).toContain('U 44.5');
    const decimal = table(g, 'decimal');
    expect(decimal).toContain('2.50');
    expect(decimal).toContain('1.59');
    expect(decimal).not.toContain('+150');
  });

  it('shows a dash for a market the book is not offering and dims a suspended one', () => {
    const g = game('g1');
    g.markets.total = null;
    g.markets.spread!.suspended = true;
    const html = table(g);
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
        book="draftkings"
        games={[g]}
        format="american"
        flashes={{ 'draftkings:g1:moneyline:home': { kind: 'down', at: Date.now() } }}
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
        book="draftkings"
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

describe('CompareTable', () => {
  const dk = game('dk1', { book: 'draftkings' });
  dk.home = { id: '1', name: 'DET Lions', shortName: 'DET' };
  dk.away = { id: '2', name: 'NO Saints', shortName: 'NO' };
  const fd = game('fd1', { book: 'fanduel' });
  fd.home = { id: 'DET', name: 'Detroit Lions', shortName: 'DET' };
  fd.away = { id: 'NO', name: 'New Orleans Saints', shortName: 'NO' };
  fd.markets.moneyline!.sides.home!.odds = { american: -165, decimal: 1.606 }; // FanDuel pays more
  fd.markets.spread!.sides.home!.line = -4; // different line from DraftKings' -3.5
  fd.markets.spread!.sides.away!.line = 4;

  it('puts both books in every cell, marks the best price and flags differing lines', () => {
    const pairs = matchGames([dk, fd]);
    expect(pairs).toHaveLength(1);
    const html = renderToString(
      <CompareTable
        pairs={pairs}
        books={['draftkings', 'fanduel']}
        format="american"
        flashes={{ 'fanduel:fd1:moneyline:home': { kind: 'up', at: Date.now() } }}
        serverNow={now}
        tzLabel="EDT"
      />,
    );
    expect(html).toContain('Detroit Lions'); // canonical name, not either book's spelling
    expect(html).toContain('-170');
    expect(html).toContain('-165');
    expect(html.match(/cmp-price--best/g)).toHaveLength(1); // only the FanDuel home moneyline
    expect(html).toContain('cmp-cell--lines-differ');
    expect(html).toContain('flash--up');
    expect(html).toContain('book-badge--fanduel');
  });

  it('shows a dash for a book that does not list the game', () => {
    const html = renderToString(
      <CompareTable
        pairs={matchGames([dk])}
        books={['draftkings', 'fanduel']}
        format="decimal"
        flashes={{}}
        serverNow={now}
        tzLabel="EDT"
      />,
    );
    expect(html).toContain('FanDuel does not list this game');
    expect(html).toContain('DraftKings only');
  });
});

describe('LeadTracker', () => {
  it('pairs the same move seen at two books and reports the lead', () => {
    const dk = game('dk1', { book: 'draftkings' });
    dk.home = { id: '1', name: 'DET Lions', shortName: 'DET' };
    dk.away = { id: '2', name: 'NO Saints', shortName: 'NO' };
    const fd = game('fd1', { book: 'fanduel' });
    fd.home = { id: 'DET', name: 'Detroit Lions', shortName: 'DET' };
    fd.away = { id: 'NO', name: 'New Orleans Saints', shortName: 'NO' };
    const base: Omit<RecentMove, 'book' | 'gameId' | 'at'> = {
      market: 'total',
      side: 'over',
      field: 'line',
      prevLine: 44.5,
      nextLine: 45,
      prevOdds: { american: -110, decimal: 1.909 },
      nextOdds: { american: -110, decimal: 1.909 },
      source: 'snapshot',
      gameLabel: 'NO @ DET',
      sideLabel: 'Over',
      browserReceivedAt: now,
      serverToBrowserMs: 3,
    };
    const moves: RecentMove[] = [
      { ...base, book: 'fanduel', gameId: 'fd1', at: new Date(now - 10_000).toISOString() },
      { ...base, book: 'draftkings', gameId: 'dk1', at: new Date(now - 40_000).toISOString() },
    ];
    const html = renderToString(
      <LeadTracker
        moves={moves}
        books={{
          draftkings: { games: { dk1: dk }, meta: null, version: 1 },
          fanduel: { games: { fd1: fd }, meta: null, version: 1 },
        }}
        format="american"
      />,
    );
    expect(html).toContain('1 paired');
    expect(html).toContain('30.00 s'); // DraftKings showed it 30 s before FanDuel
    expect(html).toMatch(/DraftKings first[^]*?<strong>1<\/strong>/);
  });
});

describe('LatencyPanel', () => {
  const counters: FeedCounters = {
    priceChanges: 3,
    socketUpdates: 12,
    socketReconnects: 0,
    restSnapshots: 2,
    restNotModified: 9,
    restFailures: 1,
    unresolvedDeltas: 0,
    driftCorrections: 0,
    snapshotLeads: 1,
    staleSnapshotSkips: 0,
    invalidEntities: 0,
  };
  const latency: LatencyStats = {
    samples: 12,
    p50Ms: 120,
    p95Ms: 400,
    lastMs: 90,
    pipelineP50Ms: 30,
    transportP50Ms: 15,
    transportMinMs: 12,
    negativeTransportSamples: 0,
    clockSkewMs: -40,
    skewSource: 'tracked',
    skewRttMs: 38,
    byPhase: {
      pregame: { samples: 12, p50Ms: 120, p95Ms: 400, pipelineP50Ms: 30 },
      inplay: { samples: 0, p50Ms: null, p95Ms: null, pipelineP50Ms: null },
    },
  };

  it('explains each book on its own terms: measured latency for DraftKings, a freshness bound for FanDuel', () => {
    const html = renderToString(
      <LatencyPanel
        dk={meta({ latency, counters })}
        fd={fdMeta({ counters })}
        browserLegSamples={[4, 6]}
        clockOffsetMs={3}
        clockRttMs={9}
        browserNow={now}
      />,
    );
    expect(html).toContain('DraftKings → server');
    expect(html).toContain('120 ms'); // DK p50
    expect(html).toContain('self-check: 0 negative of 12');
    // The comparable number leads both books' counters; frames and bodies are not comparable.
    expect(html).toContain('<strong>3 price changes</strong> · 12 push frames · 2 snapshots');
    expect(html).toContain('FanDuel freshness bound');
    expect(html).toContain('≤ 31 s'); // 30 s max-age + 1 s poll
    expect(html).toContain('generated <strong>12s ago</strong>'); // Date − Age
    expect(html).toContain('age at receipt 12 s');
    expect(html).toContain('next in 18 s');
    expect(html).toContain('<strong>304</strong>');
    expect(html).toContain(
      '<strong>3 price changes</strong> · 2 bodies · 9 not-modified · 1 failures',
    );
    expect(html).toContain('Server → this browser');

    const bypass = renderToString(
      <LatencyPanel
        dk={null}
        fd={fdMeta({ counters, poll: { ...fdMeta().poll!, bypassCache: true } })}
        browserLegSamples={[]}
        clockOffsetMs={null}
        clockRttMs={null}
        browserNow={now}
      />,
    );
    expect(bypass).not.toContain('DraftKings → server');
    expect(bypass).toContain('cache bypassed');
    expect(bypass).toContain('≤ 1.0 s'); // 1 s poll + 14 ms request, shown to one decimal
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

  it('names the state honestly for every feed condition, per transport', () => {
    expect(displayState(meta(), 'open').label).toBe('LIVE');
    expect(displayState(meta({ stale: true }), 'open')).toMatchObject({
      label: 'STALE',
      tone: 'bad',
    });
    expect(displayState(meta({ feedState: 'polling' }), 'open')).toMatchObject({
      label: 'POLLING',
      tone: 'warn',
    });
    // Polling is the healthy state for a book with no push feed.
    expect(displayState(fdMeta(), 'open')).toMatchObject({ label: 'POLLING', tone: 'good' });
    expect(displayState(meta({ feedState: 'degraded' }), 'open').tone).toBe('bad');
    expect(displayState(meta(), 'reconnecting').label).toBe('RECONNECTING');
    expect(displayState(null, 'connecting').label).toBe('CONNECTING');
  });

  it('shows contact age and end-to-end latency while live, and a freshness bound for a polled book', () => {
    const html = renderToString(
      <StatusStrip
        books={[
          { book: 'draftkings', meta: meta() },
          { book: 'fanduel', meta: fdMeta() },
        ]}
        connection="open"
        {...props}
      />,
    );
    expect(html).toContain('3s ago');
    expect(html).toContain('125 ms'); // 120 ms server p50 + 5 ms browser leg
    expect(html).toContain('≤ 31 s'); // 30 s CDN max-age + 1 s poll
    expect(freshnessBoundMs(fdMeta())).toBe(31_000);
    expect(freshnessBoundMs(fdMeta({ poll: { ...fdMeta().poll!, bypassCache: true } }))).toBe(
      1_014,
    );
    const polling = renderToString(
      <StatusStrip
        books={[{ book: 'draftkings', meta: meta({ feedState: 'polling' }) }]}
        connection="open"
        {...props}
      />,
    );
    expect(polling).toContain('n/a (polling)');
  });
});

describe('useOddsFeed reducer', () => {
  it('keeps each book apart: snapshots, deltas, flashes and moves carry the book', () => {
    const snap = reducer(initialState, {
      type: 'snapshot',
      snapshot: { version: 1, games: [game('g1')], meta: meta() },
      at: now,
    });
    const both = reducer(snap, {
      type: 'snapshot',
      snapshot: { version: 7, games: [game('g1', { book: 'fanduel' })], meta: fdMeta() },
      at: now,
    });
    expect(Object.keys(both.books)).toEqual(['draftkings', 'fanduel']);
    expect(both.books.fanduel?.version).toBe(7);
    expect(both.connection).toBe('open');

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
    const next = reducer(both, { type: 'delta', delta, at: now, offset: 0 });
    expect(next.books.draftkings?.version).toBe(2);
    expect(next.books.draftkings?.games.g1!.markets.moneyline!.sides.home!.odds.american).toBe(
      -200,
    );
    expect(next.books.fanduel?.games.g1!.markets.moneyline!.sides.home!.odds.american).toBe(-170); // untouched
    expect(next.flashes['draftkings:g1:moneyline:home']).toMatchObject({ kind: 'down' });
    expect(next.moves[0]).toMatchObject({
      book: 'draftkings',
      gameLabel: 'AWY @ HOM',
      serverToBrowserMs: 40,
    });
    expect(next.browserLegSamples).toEqual([40]);

    const gone = reducer(next, {
      type: 'delta',
      delta: { ...delta, version: 3, games: [], removedGameIds: ['g1'], changes: [] },
      at: now,
      offset: 0,
    });
    expect(gone.books.draftkings?.games.g1).toBeUndefined();
    expect(gone.books.fanduel?.games.g1).toBeDefined();
  });

  it('lets a heartbeat update every book`s staleness without touching the odds', () => {
    const snap = reducer(initialState, {
      type: 'snapshot',
      snapshot: { version: 1, games: [game('g1')], meta: meta() },
      at: now,
    });
    const beat = reducer(snap, {
      type: 'heartbeat',
      heartbeat: {
        serverTime: new Date().toISOString(),
        books: [
          {
            book: 'draftkings',
            version: 1,
            feedState: 'polling',
            stale: true,
            lastContactAt: new Date(now - 100_000).toISOString(),
          },
          { book: 'fanduel', version: 1, feedState: 'polling', stale: false, lastContactAt: null },
        ],
      },
      at: now,
    });
    expect(beat.books.draftkings?.meta?.stale).toBe(true);
    expect(beat.books.draftkings?.meta?.feedState).toBe('polling');
    expect(beat.books.draftkings?.games).toBe(snap.books.draftkings?.games);
    expect(beat.books.fanduel).toBeUndefined(); // no snapshot for it yet: nothing to update
  });
});
