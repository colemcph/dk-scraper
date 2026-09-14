import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BookAdapter,
  LeagueRef,
  SnapshotResult,
  SubscriptionHandlers,
} from '../src/server/book.js';
import { FeedManager } from '../src/server/feed.js';
import { OddsStore } from '../src/server/store.js';
import { silentLogger } from '../src/server/logger.js';
import type { DeltaEvent, FeedMeta, Game } from '../src/shared/types.js';
import { emptyDelta, game } from './helpers.js';

const NFL: LeagueRef = { id: '88808', name: 'NFL', subcategoryId: '4518' };

class FakeAdapter implements BookAdapter {
  readonly book = 'draftkings' as const;
  readonly site = 'dkcaon';
  games: Game[] = [game('g1')];
  failNext = 0;
  fetches = 0;
  handlers: SubscriptionHandlers | null = null;
  closed = 0;
  withSocket = true;

  async fetchSnapshot(): Promise<SnapshotResult> {
    this.fetches++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('HTTP 403 Access Denied');
    }
    return {
      games: JSON.parse(JSON.stringify(this.games)),
      fetchedAt: new Date().toISOString(),
      durationMs: 5,
      invalidEntities: 0,
    };
  }

  subscribe(_league: LeagueRef, _spec: unknown, handlers: SubscriptionHandlers) {
    this.handlers = handlers;
    return { close: () => this.closed++ };
  }
}

const config = {
  resyncIntervalMs: 60_000,
  pollIntervalMs: 3_000,
  wsFallbackAfterMs: 15_000,
  staleAfterMs: 90_000,
  refreshMinIntervalMs: 5_000,
  bootstrapBackoffBaseMs: 1_000,
  bootstrapBackoffMaxMs: 8_000,
  unresolvedResyncDelayMs: 5_000,
};

function setup(adapter = new FakeAdapter()) {
  if (!adapter.withSocket) (adapter as Partial<BookAdapter>).subscribe = undefined;
  const store = new OddsStore(NFL.id);
  const feed = new FeedManager({ adapter, league: NFL, store, logger: silentLogger, config });
  const deltas: DeltaEvent[] = [];
  const metas: FeedMeta[] = [];
  feed.on('delta', (d) => deltas.push(d));
  feed.on('meta', (m) => metas.push(m));
  return { adapter, store, feed, deltas, metas };
}

/** Let pending promises settle without advancing fake timers. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('FeedManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T01:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('bootstraps from a snapshot, opens the socket and goes live on subscribe', async () => {
    const h = setup();
    h.feed.start();
    await flush();
    expect(h.store.size).toBe(1);
    expect(h.deltas).toHaveLength(1);
    expect(h.feed.feedState).toBe('bootstrapping');
    expect(h.adapter.handlers).not.toBeNull();

    h.adapter.handlers!.onState('subscribed');
    expect(h.feed.feedState).toBe('live');
    const meta = h.feed.meta();
    expect(meta.stale).toBe(false);
    expect(meta.lastSnapshotAt).not.toBeNull();
    h.feed.stop();
  });

  it('retries with backoff while DraftKings is unreachable and serves nothing until it succeeds', async () => {
    const adapter = new FakeAdapter();
    adapter.failNext = 2;
    const h = setup(adapter);
    h.feed.start();
    await flush();
    expect(h.feed.feedState).toBe('degraded');
    expect(h.feed.meta().lastError?.message).toContain('403');
    expect(h.feed.snapshot().games).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_300); // attempt 2 (fails)
    expect(h.feed.feedState).toBe('degraded');
    await vi.advanceTimersByTimeAsync(2_600); // attempt 3 (succeeds)
    expect(h.store.size).toBe(1);
    expect(h.adapter.fetches).toBe(3);
    h.adapter.handlers!.onState('subscribed');
    expect(h.feed.feedState).toBe('live');
    h.feed.stop();
  });

  it('falls back to polling when the socket stays down, and resyncs when it returns', async () => {
    const h = setup();
    h.feed.start();
    await flush();
    h.adapter.handlers!.onState('subscribed');
    expect(h.feed.feedState).toBe('live');

    h.adapter.handlers!.onState('closed', { code: 1006 });
    expect(h.feed.feedState).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.feed.feedState).toBe('polling');

    const before = h.adapter.fetches;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.adapter.fetches).toBe(before + 3); // one poll per pollIntervalMs

    h.adapter.games[0]!.markets.moneyline!.sides.home!.odds = { american: -200, decimal: 1.5 };
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.deltas.at(-1)!.changes[0]).toMatchObject({ side: 'home', source: 'snapshot' });

    const fetchesBeforeReconnect = h.adapter.fetches;
    h.adapter.handlers!.onState('subscribed');
    expect(h.feed.feedState).toBe('live');
    await flush();
    expect(h.adapter.fetches).toBe(fetchesBeforeReconnect + 1); // gap-filling resync
    expect(h.feed.meta().counters.socketReconnects).toBe(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.adapter.fetches).toBe(fetchesBeforeReconnect + 1); // polling stopped
    h.feed.stop();
  });

  it('applies socket deltas with latency and resyncs when a delta references unknown ids', async () => {
    const h = setup();
    h.feed.start();
    await flush();
    h.adapter.handlers!.onAck({ rttMs: 40, skewMs: 1800, at: new Date().toISOString() });
    h.adapter.handlers!.onState('subscribed');

    const now = Date.now();
    const delta = emptyDelta();
    delta.createdAt = new Date(now + 1800 - 150).toISOString(); // DK clock is 1.8 s ahead; created 150 ms ago
    delta.publishedAt = new Date(now + 1800 - 100).toISOString();
    delta.receivedAt = new Date(now).toISOString();
    delta.selections.upsert.push({
      sourceSelectionId: 'g1-ml-a',
      odds: { american: 170, decimal: 2.7 },
    });
    h.adapter.handlers!.onDelta(delta);

    const last = h.deltas.at(-1)!;
    expect(last.changes[0]!.latency).toMatchObject({
      dkToServerMs: 150,
      dkPipelineMs: 50,
      skewCorrected: true,
    });
    expect(h.feed.meta().latency.p50Ms).toBe(150);
    expect(h.feed.meta().latency.byPhase.pregame.samples).toBe(1);

    // Once the game is live, its samples are attributed to the in-play bucket.
    const live = emptyDelta();
    live.games.patch.push({ id: 'g1', status: 'live' });
    live.selections.upsert.push({
      sourceSelectionId: 'g1-ml-h',
      odds: { american: -150, decimal: 1.667 },
    });
    h.adapter.handlers!.onDelta(live);
    expect(h.feed.meta().latency.byPhase.inplay.samples).toBe(1);
    expect(h.feed.meta().counters.socketUpdates).toBe(2);

    const fetches = h.adapter.fetches;
    const ghost = emptyDelta();
    ghost.selections.upsert.push({
      sourceSelectionId: 'ghost',
      odds: { american: 100, decimal: 2 },
    });
    h.adapter.handlers!.onDelta(ghost);
    expect(h.feed.meta().counters.unresolvedDeltas).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.adapter.fetches).toBe(fetches + 1);
    h.feed.stop();
  });

  it('flags the feed stale after a silence and clears it on contact', async () => {
    const h = setup();
    h.feed.start();
    await flush();
    h.adapter.handlers!.onState('subscribed');
    expect(h.feed.meta().stale).toBe(false);
    // no resync: keep state live but silence the upstream
    h.adapter.failNext = 100;
    await vi.advanceTimersByTimeAsync(95_000);
    expect(h.feed.meta().stale).toBe(true);
    expect(h.feed.snapshot().games).toHaveLength(1); // last-known-good still served
    h.adapter.handlers!.onActivity(new Date().toISOString());
    expect(h.feed.meta().stale).toBe(false);
    h.feed.stop();
  });

  it('rate-limits manual refreshes and counts drift found by a live resync', async () => {
    const h = setup();
    h.feed.start();
    await flush();
    h.adapter.handlers!.onState('subscribed');

    h.adapter.games[0]!.markets.total!.sides.over!.odds = { american: -120, decimal: 1.833 };
    const first = await h.feed.refresh();
    expect(first.ok).toBe(true);
    expect(first.changes).toBe(1);
    // Not drift yet: DraftKings may simply not have published it to the socket.
    expect(h.feed.meta().counters.driftCorrections).toBe(0);

    const second = await h.feed.refresh();
    expect(second.ok).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);

    // ...but if the socket never confirms it within the grace window, it is drift.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.feed.meta().counters.driftCorrections).toBe(1);
    h.feed.stop();
  });

  it('does not count a snapshot-first change as drift once the socket confirms it', async () => {
    const h = setup();
    h.feed.start();
    await flush();
    h.adapter.handlers!.onState('subscribed');
    h.adapter.games[0]!.markets.total!.sides.over!.odds = { american: -120, decimal: 1.833 };
    await h.feed.refresh();
    expect(h.feed.meta().counters.driftCorrections).toBe(0);

    // The socket publishes the same value a couple of seconds later.
    await vi.advanceTimersByTimeAsync(2_000);
    const confirm = emptyDelta();
    confirm.selections.upsert.push({
      sourceSelectionId: 'g1-t-o',
      odds: { american: -120, decimal: 1.833 },
    });
    h.adapter.handlers!.onDelta(confirm);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.feed.meta().counters.snapshotLeads).toBe(1);
    expect(h.feed.meta().counters.driftCorrections).toBe(0);
    h.feed.stop();
  });

  it('polls when the adapter has no push feed', async () => {
    const adapter = new FakeAdapter();
    adapter.withSocket = false;
    const h = setup(adapter);
    h.feed.start();
    await flush();
    expect(h.feed.feedState).toBe('polling');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.adapter.fetches).toBe(3);
    h.feed.stop();
  });
});
