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
  transport: 'push' | 'poll' = 'push';
  readonly site = 'dkcaon';
  games: Game[] = [game('g1')];
  failNext = 0;
  fetches = 0;
  handlers: SubscriptionHandlers | null = null;
  closed = 0;
  withSocket = true;
  /** Poll-transport behaviour: answer the next N fetches with 304 Not Modified, and a cache-aware delay hint. */
  notModifiedNext = 0;
  hintMs: number | undefined;
  /** When set, failures carry the delay the upstream asked for (an HTTP Retry-After). */
  retryAfterMs: number | undefined;

  async fetchSnapshot(): Promise<SnapshotResult> {
    this.fetches++;
    if (this.failNext > 0) {
      this.failNext--;
      if (this.retryAfterMs === undefined) throw new Error('HTTP 403 Access Denied');
      const err = new Error('HTTP 429 Too Many Requests') as Error & { retryAfterMs: number };
      err.retryAfterMs = this.retryAfterMs;
      throw err;
    }
    const hint = this.hintMs !== undefined ? { nextPollInMs: this.hintMs } : {};
    if (this.notModifiedNext > 0) {
      this.notModifiedNext--;
      return {
        games: [],
        fetchedAt: new Date().toISOString(),
        durationMs: 2,
        invalidEntities: 0,
        notModified: true,
        ...hint,
      };
    }
    return {
      games: JSON.parse(JSON.stringify(this.games)),
      fetchedAt: new Date().toISOString(),
      durationMs: 5,
      invalidEntities: 0,
      ...hint,
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
  if (!adapter.withSocket) {
    (adapter as Partial<BookAdapter>).subscribe = undefined;
    adapter.transport = 'poll';
  }
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
    expect(h.feed.meta().transport).toBe('poll');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.adapter.fetches).toBe(3);
    h.feed.stop();
  });

  it('treats 304 Not Modified as contact without a delta, and follows the poll hint within its clamps', async () => {
    const adapter = new FakeAdapter();
    adapter.withSocket = false;
    const h = setup(adapter);
    h.feed.start();
    await flush();
    expect(h.deltas).toHaveLength(1); // bootstrap snapshot

    // The adapter reads "this copy cannot change for 9 s" off the cache headers: no poll before then.
    adapter.hintMs = 9_000;
    adapter.notModifiedNext = 5;
    await vi.advanceTimersByTimeAsync(3_000); // base cadence: first poll at 3 s carries the hint back
    expect(adapter.fetches).toBe(2);
    await vi.advanceTimersByTimeAsync(8_000); // 11 s: still sleeping through the hint
    expect(adapter.fetches).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000); // 12 s: hint elapsed
    expect(adapter.fetches).toBe(3);

    const meta = h.feed.meta();
    expect(meta.counters.restNotModified).toBe(2);
    expect(meta.counters.restSnapshots).toBe(1);
    expect(meta.stale).toBe(false);
    expect(Date.parse(meta.lastContactAt!)).toBe(Date.now()); // a 304 is contact
    expect(Date.parse(meta.lastSnapshotAt!)).toBe(Date.now()); // and confirms the state
    expect(h.deltas).toHaveLength(1); // nothing to broadcast
    expect(h.metas.at(-1)?.counters.restNotModified).toBe(2); // but the poll was announced

    // A hint below the base cadence is clamped up to it; a real change is applied and broadcast.
    adapter.hintMs = 10;
    adapter.notModifiedNext = 0;
    adapter.games[0]!.markets.moneyline!.sides.home!.odds = { american: -200, decimal: 1.5 };
    await vi.advanceTimersByTimeAsync(9_000); // 21 s: the 9 s hint from fetch 3
    expect(adapter.fetches).toBe(4);
    expect(h.deltas).toHaveLength(2);
    expect(h.deltas[1]!.changes[0]).toMatchObject({ side: 'home', source: 'snapshot' });
    await vi.advanceTimersByTimeAsync(3_000); // 24 s: base cadence, not 10 ms
    expect(adapter.fetches).toBe(5);

    // And a huge hint is clamped down to pollMaxIntervalMs (2 min by default).
    adapter.hintMs = 10 * 60_000;
    await vi.advanceTimersByTimeAsync(3_000); // 27 s: fetch 6 returns the huge hint
    expect(adapter.fetches).toBe(6);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(adapter.fetches).toBe(6);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.fetches).toBe(7);
    h.feed.stop();
  });

  it('backs off after failed polls rather than hammering, and returns to the cache-aware cadence', async () => {
    const adapter = new FakeAdapter();
    adapter.withSocket = false;
    adapter.hintMs = 20_000; // "the CDN copy cannot change for 20 s"
    const h = setup(adapter);
    h.feed.start();
    await flush();
    expect(adapter.fetches).toBe(1);

    adapter.failNext = 4;
    await vi.advanceTimersByTimeAsync(20_000); // the hint the bootstrap response carried
    expect(adapter.fetches).toBe(2); // 1st failure -> base (3 s)
    expect(h.feed.feedState).toBe('degraded');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(adapter.fetches).toBe(3); // 2nd failure -> 6 s
    await vi.advanceTimersByTimeAsync(5_999);
    expect(adapter.fetches).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.fetches).toBe(4); // 3rd failure -> 12 s, capped at 8 s
    await vi.advanceTimersByTimeAsync(8_000);
    expect(adapter.fetches).toBe(5); // 4th failure -> still 8 s
    await vi.advanceTimersByTimeAsync(8_000);
    expect(adapter.fetches).toBe(6); // recovered
    expect(h.feed.feedState).toBe('polling');

    // A success clears the backoff, so the adapter's own hint applies again — not the 8 s ceiling.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(adapter.fetches).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.fetches).toBe(7);
    h.feed.stop();
  });

  it('waits at least as long as an upstream Retry-After before polling again', async () => {
    const adapter = new FakeAdapter();
    adapter.withSocket = false;
    const h = setup(adapter);
    h.feed.start();
    await flush();

    adapter.failNext = 1;
    adapter.retryAfterMs = 45_000; // longer than any backoff we would have picked
    await vi.advanceTimersByTimeAsync(3_000);
    expect(adapter.fetches).toBe(2);
    expect(h.feed.meta().lastError?.message).toContain('429');
    await vi.advanceTimersByTimeAsync(44_999);
    expect(adapter.fetches).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.fetches).toBe(3);
    h.feed.stop();
  });

  it('keeps polling through an outage and reports a poll-only book as degraded, not reconnecting', async () => {
    const adapter = new FakeAdapter();
    adapter.withSocket = false;
    const h = setup(adapter);
    h.feed.start();
    await flush();
    adapter.failNext = 2;
    await vi.advanceTimersByTimeAsync(3_000); // 1st failure
    expect(h.feed.feedState).toBe('degraded');
    expect(h.feed.snapshot().games).toHaveLength(1); // last-known-good still served
    await vi.advanceTimersByTimeAsync(3_000); // 2nd failure -> next attempt backed off to 6 s
    expect(h.feed.meta().counters.restFailures).toBe(2);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.feed.feedState).toBe('polling');
    h.feed.stop();
  });
});
