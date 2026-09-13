import { describe, expect, it } from 'vitest';
import { OddsStore } from '../src/server/feed/store.js';
import { clone, emptyDelta, game, T0 } from './helpers.js';

const T1 = '2026-09-13T01:00:10.000Z';
const T2 = '2026-09-13T01:00:20.000Z';

describe('OddsStore.applySnapshot', () => {
  it('loads an initial snapshot without reporting odds changes', () => {
    const store = new OddsStore('88808');
    const cs = store.applySnapshot([game('g1'), game('g2')], T0);
    expect(cs.changed).toBe(true);
    expect(cs.changes).toHaveLength(0);
    expect(cs.touchedGameIds.sort()).toEqual(['g1', 'g2']);
    expect(store.version).toBe(1);
    expect(store.list().map((g) => g.id)).toEqual(['g1', 'g2']);
  });

  it('is a no-op when nothing changed', () => {
    const store = new OddsStore('88808');
    store.applySnapshot([game('g1')], T0);
    const cs = store.applySnapshot([game('g1')], T1);
    expect(cs.changed).toBe(false);
    expect(store.version).toBe(1);
    expect(store.getGame('g1')!.updatedAt).toBe(T0);
  });

  it('diffs a resync: records prev price, change event and bumps version', () => {
    const store = new OddsStore('88808');
    store.applySnapshot([game('g1')], T0);
    const next = game('g1');
    next.markets.moneyline!.sides.home!.odds = { american: -180, decimal: 1.556 };
    const cs = store.applySnapshot([next], T1);
    expect(cs.changes).toEqual([
      expect.objectContaining({
        gameId: 'g1',
        market: 'moneyline',
        side: 'home',
        field: 'odds',
        source: 'snapshot',
      }),
    ]);
    const home = store.getGame('g1')!.markets.moneyline!.sides.home!;
    expect(home.prev).toEqual({ odds: { american: -170, decimal: 1.588 }, changedAt: T1 });
    expect(home.updatedAt).toBe(T1);
    // untouched side keeps its original timestamp
    expect(store.getGame('g1')!.markets.moneyline!.sides.away!.updatedAt).toBe(T0);
    expect(store.version).toBe(2);
  });

  it('reports a line move as field=line and keeps prev.line', () => {
    const store = new OddsStore('88808');
    store.applySnapshot([game('g1')], T0);
    const next = game('g1');
    next.markets.spread!.sides.home!.line = -4;
    next.markets.spread!.sides.home!.sourceSelectionId = 'new-id';
    const cs = store.applySnapshot([next], T1);
    expect(cs.changes[0]).toMatchObject({ field: 'line', prevLine: -3.5, nextLine: -4 });
    expect(store.getGame('g1')!.markets.spread!.sides.home!.prev?.line).toBe(-3.5);
  });

  it('removes games missing from the snapshot', () => {
    const store = new OddsStore('88808');
    store.applySnapshot([game('g1'), game('g2')], T0);
    const cs = store.applySnapshot([game('g1')], T1);
    expect(cs.removedGameIds).toEqual(['g2']);
    expect(store.getGame('g2')).toBeUndefined();
  });

  it('keeps prev history across an unchanged resync', () => {
    const store = new OddsStore('88808');
    store.applySnapshot([game('g1')], T0);
    const moved = game('g1');
    moved.markets.total!.sides.over!.odds = { american: -115, decimal: 1.87 };
    store.applySnapshot([moved], T1);
    store.applySnapshot([clone(moved)], T2);
    expect(store.getGame('g1')!.markets.total!.sides.over!.prev?.odds.american).toBe(-110);
  });
});

describe('OddsStore.applyDelta', () => {
  function seeded() {
    const store = new OddsStore('88808');
    store.applySnapshot([game('g1')], T0);
    return store;
  }

  it('applies an in-place price change resolved by selection id', () => {
    const store = seeded();
    const delta = emptyDelta(T1);
    delta.selections.upsert.push({
      sourceSelectionId: 'g1-ml-h',
      odds: { american: -190, decimal: 1.526 },
    });
    const res = store.applyDelta(delta);
    expect(res.unresolved).toEqual([]);
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]).toMatchObject({
      side: 'home',
      market: 'moneyline',
      field: 'odds',
      source: 'socket',
    });
    const home = store.getGame('g1')!.markets.moneyline!.sides.home!;
    expect(home.odds.american).toBe(-190);
    expect(home.prev?.odds.american).toBe(-170);
    expect(home.updatedAt).toBe(T1);
    expect(store.getGame('g1')!.updatedAt).toBe(T1);
  });

  it('re-keys a selection on a line move via replacedSelectionId (no marketId on the frame)', () => {
    const store = seeded();
    const delta = emptyDelta(T1);
    delta.selections.upsert.push({
      sourceSelectionId: 'g1-sp-h-NEW',
      replacedSelectionId: 'g1-sp-h',
      line: -4,
      odds: { american: -105, decimal: 1.952 },
    });
    const res = store.applyDelta(delta);
    expect(res.unresolved).toEqual([]);
    expect(res.changes[0]).toMatchObject({ field: 'line', prevLine: -3.5, nextLine: -4 });
    const home = store.getGame('g1')!.markets.spread!.sides.home!;
    expect(home.sourceSelectionId).toBe('g1-sp-h-NEW');

    // The new id is now addressable, the old one is gone.
    const again = emptyDelta(T2);
    again.selections.upsert.push({
      sourceSelectionId: 'g1-sp-h-NEW',
      odds: { american: -115, decimal: 1.87 },
    });
    expect(store.applyDelta(again).unresolved).toEqual([]);
    const stale = emptyDelta(T2);
    stale.selections.upsert.push({
      sourceSelectionId: 'g1-sp-h',
      odds: { american: -115, decimal: 1.87 },
    });
    expect(store.applyDelta(stale).unresolved).toEqual(['selection:g1-sp-h']);
  });

  it('places an added selection by market id + side when the id is new', () => {
    const store = seeded();
    const rm = emptyDelta(T1);
    rm.selections.remove.push('g1-t-o');
    store.applyDelta(rm);
    expect(store.getGame('g1')!.markets.total!.sides.over).toBeUndefined();

    const add = emptyDelta(T2);
    add.selections.upsert.push({
      sourceSelectionId: 'g1-t-o2',
      sourceMarketId: 'g1-t',
      key: 'over',
      line: 45.5,
      label: 'Over',
      odds: { american: -110, decimal: 1.909 },
    });
    const res = store.applyDelta(add);
    expect(res.unresolved).toEqual([]);
    expect(store.getGame('g1')!.markets.total!.sides.over?.line).toBe(45.5);
  });

  it('reports unknown ids so the caller can resync', () => {
    const store = seeded();
    const delta = emptyDelta(T1);
    delta.selections.upsert.push({
      sourceSelectionId: 'ghost',
      odds: { american: 100, decimal: 2 },
    });
    delta.games.patch.push({ id: 'unknown-game', status: 'live' });
    const res = store.applyDelta(delta);
    expect(res.unresolved).toEqual(['event:unknown-game', 'selection:ghost']);
    expect(res.changed).toBe(false);
  });

  it('is idempotent: re-applying the same frame produces no change', () => {
    const store = seeded();
    const delta = emptyDelta(T1);
    delta.selections.upsert.push({
      sourceSelectionId: 'g1-ml-a',
      odds: { american: 160, decimal: 2.6 },
    });
    expect(store.applyDelta(delta).changes).toHaveLength(1);
    const v = store.version;
    const res = store.applyDelta(delta);
    expect(res.changes).toHaveLength(0);
    expect(res.changed).toBe(false);
    expect(store.version).toBe(v);
  });

  it('applies market suspension patches and event status/score patches', () => {
    const store = seeded();
    const delta = emptyDelta(T1);
    delta.markets.patch.push({ sourceMarketId: 'g1-ml', suspended: true });
    delta.games.patch.push({
      id: 'g1',
      status: 'live',
      live: { period: '2nd', homeScore: 7, awayScore: 3 },
    });
    const res = store.applyDelta(delta);
    expect(res.changed).toBe(true);
    const g = store.getGame('g1')!;
    expect(g.markets.moneyline!.suspended).toBe(true);
    expect(g.status).toBe('live');
    expect(g.live).toEqual({ period: '2nd', homeScore: 7, awayScore: 3 });
    // sides survive suspension
    expect(g.markets.moneyline!.sides.home).toBeDefined();
  });

  it('removes markets and games', () => {
    const store = seeded();
    const delta = emptyDelta(T1);
    delta.markets.remove.push('g1-sp');
    let res = store.applyDelta(delta);
    expect(store.getGame('g1')!.markets.spread).toBeNull();
    expect(res.touchedGameIds).toEqual(['g1']);

    const gone = emptyDelta(T2);
    gone.games.remove.push('g1');
    res = store.applyDelta(gone);
    expect(res.removedGameIds).toEqual(['g1']);
    expect(store.list()).toHaveLength(0);
  });

  it('does not let an older snapshot overwrite what the socket delivered after it was fetched', () => {
    const store = seeded();
    const fetchStartedAt = '2026-09-13T01:00:10.000Z';
    // Socket delivers a newer price 150 ms after the snapshot request went out...
    const delta = emptyDelta('2026-09-13T01:00:10.100Z');
    delta.receivedAt = '2026-09-13T01:00:10.150Z';
    delta.selections.upsert.push({
      sourceSelectionId: 'g1-ml-h',
      odds: { american: -200, decimal: 1.5 },
    });
    delta.games.patch.push({ id: 'g1', status: 'live', live: { period: '1st' } });
    store.applyDelta(delta);
    // ...and the (older) snapshot, still showing -170 and "upcoming", is applied afterwards.
    const stale = game('g1');
    const cs = store.applySnapshot([stale], fetchStartedAt);
    expect(cs.changes).toHaveLength(0);
    expect(cs.skippedStale).toBeGreaterThan(0);
    expect(store.getGame('g1')!.markets.moneyline!.sides.home!.odds.american).toBe(-200);
    expect(store.getGame('g1')!.status).toBe('live');
    // A later snapshot (fetched after the socket write) is applied normally.
    const later = game('g1');
    later.markets.moneyline!.sides.home!.odds = { american: -210, decimal: 1.476 };
    const cs2 = store.applySnapshot([later], '2026-09-13T01:00:20.000Z');
    expect(cs2.changes).toHaveLength(1);
    expect(store.getGame('g1')!.markets.moneyline!.sides.home!.odds.american).toBe(-210);
  });

  it('keeps a game the socket added after an older snapshot that lacks it', () => {
    const store = seeded();
    const delta = emptyDelta('2026-09-13T01:00:10.100Z');
    delta.receivedAt = '2026-09-13T01:00:10.150Z';
    const g2 = game('g2');
    delta.games.upsert.push({
      id: g2.id,
      startTime: g2.startTime,
      status: g2.status,
      home: g2.home,
      away: g2.away,
      updatedAt: g2.updatedAt,
    });
    store.applyDelta(delta);
    const cs = store.applySnapshot([game('g1')], '2026-09-13T01:00:10.000Z');
    expect(cs.removedGameIds).toEqual([]);
    expect(store.getGame('g2')).toBeDefined();
  });

  it('hides games that kicked off hours ago even if the status string was unrecognised', () => {
    const store = new OddsStore('88808');
    const old = game('old', { startTime: '2026-09-13T17:00:00.000Z', status: 'upcoming' });
    const fresh = game('fresh', { startTime: '2026-09-14T00:20:00.000Z', status: 'upcoming' });
    store.applySnapshot([old, fresh], T0);
    const now = Date.parse('2026-09-14T00:00:00.000Z'); // 7 h after "old" kicked off
    expect(store.list(now).map((g) => g.id)).toEqual(['fresh']);
  });

  it('hides finished games from list() until the next snapshot drops them', () => {
    const store = seeded();
    const delta = emptyDelta(T1);
    delta.games.patch.push({ id: 'g1', status: 'finished' });
    store.applyDelta(delta);
    expect(store.list()).toHaveLength(0);
    expect(store.getGame('g1')).toBeDefined();
  });
});
