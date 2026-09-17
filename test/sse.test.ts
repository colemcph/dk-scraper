import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedManager } from '../src/server/feed.js';
import { silentLogger } from '../src/server/logger.js';
import { SseHub, type SseMessage } from '../src/server/sse.js';
import type { BookId, DeltaEvent, FeedMeta, OddsSnapshot } from '../src/shared/types.js';
import { game } from './helpers.js';

/** Just enough of a FeedManager for the hub: event registration + snapshot/meta getters. */
function fakeFeed(book: BookId = 'draftkings') {
  const listeners = {
    delta: new Set<(d: DeltaEvent) => void>(),
    meta: new Set<(m: FeedMeta) => void>(),
  };
  let version = 1;
  const meta = (): FeedMeta =>
    ({
      book,
      bookName: book === 'draftkings' ? 'DraftKings' : 'FanDuel',
      transport: book === 'draftkings' ? 'push' : 'poll',
      feedState: book === 'draftkings' ? 'live' : 'polling',
      stale: false,
      version,
      lastContactAt: new Date().toISOString(),
      serverTime: new Date().toISOString(),
      latency: {
        samples: 0,
        p50Ms: null,
        p95Ms: null,
        lastMs: null,
        clockSkewMs: null,
        skewRttMs: null,
      },
    }) as unknown as FeedMeta;
  const feed = {
    book,
    on(event: 'delta' | 'meta', l: (x: never) => void) {
      (listeners[event] as Set<(x: never) => void>).add(l);
      return () => (listeners[event] as Set<(x: never) => void>).delete(l);
    },
    snapshot: (): OddsSnapshot => ({ version, games: [game('g1', { book })], meta: meta() }),
    meta,
  } as unknown as FeedManager;
  const emitDelta = (changes = 0) => {
    version++;
    const d: DeltaEvent = {
      version,
      games: [game('g1', { book })],
      removedGameIds: [],
      changes: [],
      meta: meta(),
      emittedAt: new Date().toISOString(),
    };
    for (let i = 0; i < changes; i++)
      d.changes.push({
        gameId: 'g1',
        market: 'moneyline',
        side: 'home',
        field: 'odds',
        nextOdds: { american: -120, decimal: 1.833 },
        at: d.emittedAt,
        source: 'socket',
      });
    for (const l of listeners.delta) l(d);
    return d;
  };
  const emitMeta = () => {
    for (const l of listeners.meta) l(meta());
  };
  return { feed, emitDelta, emitMeta };
}

class FakeSink {
  messages: SseMessage[] = [];
  fail = false;
  async write(m: SseMessage): Promise<void> {
    if (this.fail) throw new Error('socket hang up');
    this.messages.push(m);
  }
}

describe('SseHub', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a snapshot on connect and deltas as they happen, with sequence ids', async () => {
    const { feed, emitDelta } = fakeFeed();
    const hub = new SseHub({ feeds: [feed], logger: silentLogger, heartbeatIntervalMs: 10_000 });
    hub.start();
    const sink = new FakeSink();
    hub.add(sink);
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.messages[0]).toMatchObject({ event: 'snapshot', id: '0', retry: 2000 });
    expect(JSON.parse(sink.messages[0]!.data).games).toHaveLength(1);

    emitDelta();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.messages[1]).toMatchObject({ event: 'delta', id: '1' });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sink.messages.at(-1)!.event).toBe('heartbeat');
    expect(JSON.parse(sink.messages.at(-1)!.data)).toMatchObject({
      books: [{ book: 'draftkings', version: 2, feedState: 'live', stale: false }],
    });
    hub.stop();
  });

  it('multiplexes several books: a snapshot per book on connect, one id sequence across them', async () => {
    const dk = fakeFeed('draftkings');
    const fd = fakeFeed('fanduel');
    const hub = new SseHub({
      feeds: [dk.feed, fd.feed],
      logger: silentLogger,
      heartbeatIntervalMs: 10_000,
    });
    hub.start();
    const sink = new FakeSink();
    hub.add(sink);
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.messages.map((m) => `${m.event}:${JSON.parse(m.data).meta.book}`)).toEqual([
      'snapshot:draftkings',
      'snapshot:fanduel',
    ]);

    fd.emitDelta();
    dk.emitDelta();
    fd.emitMeta();
    await vi.advanceTimersByTimeAsync(0);
    const tail = sink.messages.slice(2);
    expect(
      tail.map(
        (m) =>
          `${m.event}:${m.id ?? '-'}:${JSON.parse(m.data).meta?.book ?? JSON.parse(m.data).book}`,
      ),
    ).toEqual(['delta:1:fanduel', 'delta:2:draftkings', 'meta:-:fanduel']);

    await vi.advanceTimersByTimeAsync(10_000);
    const beat = JSON.parse(sink.messages.at(-1)!.data) as { books: { book: string }[] };
    expect(beat.books.map((b) => b.book)).toEqual(['draftkings', 'fanduel']);

    // A reconnect after the FanDuel delta only replays the DraftKings one.
    const resume = new FakeSink();
    hub.add(resume, '1');
    await vi.advanceTimersByTimeAsync(0);
    expect(resume.messages.map((m) => `${m.event}:${m.id}`)).toEqual(['delta:2']);
    hub.stop();
  });

  it('replays missed deltas for a reconnecting client with Last-Event-ID, else resends snapshots', async () => {
    const { feed, emitDelta } = fakeFeed();
    const hub = new SseHub({
      feeds: [feed],
      logger: silentLogger,
      heartbeatIntervalMs: 10_000,
      replayBufferSize: 3,
    });
    hub.start();
    emitDelta(); // seq 1
    emitDelta(); // seq 2
    emitDelta(); // seq 3

    const resume = new FakeSink();
    hub.add(resume, '1');
    await vi.advanceTimersByTimeAsync(0);
    expect(resume.messages.map((m) => `${m.event}:${m.id}`)).toEqual(['delta:2', 'delta:3']);

    const tooOld = new FakeSink();
    emitDelta(); // seq 4 -> buffer now holds 2,3,4; a client at 0 can't be caught up
    hub.add(tooOld, '0');
    await vi.advanceTimersByTimeAsync(0);
    expect(tooOld.messages[0]!.event).toBe('snapshot');

    const current = new FakeSink();
    hub.add(current, '4');
    await vi.advanceTimersByTimeAsync(0);
    expect(current.messages[0]!.event).toBe('snapshot'); // up to date: a fresh snapshot is cheap and safe
    expect(current.messages[0]!.id).toBe('4');
    hub.stop();
  });

  it('drops clients whose writes fail', async () => {
    const { feed, emitDelta } = fakeFeed();
    const hub = new SseHub({ feeds: [feed], logger: silentLogger, heartbeatIntervalMs: 10_000 });
    hub.start();
    const bad = new FakeSink();
    const good = new FakeSink();
    hub.add(bad);
    hub.add(good);
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.clientCount).toBe(2);
    bad.fail = true;
    emitDelta();
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.clientCount).toBe(1);
    expect(good.messages).toHaveLength(2);
    hub.stop();
  });

  it('resolves the client promise when removed so the HTTP handler can end the response', async () => {
    const { feed } = fakeFeed();
    const hub = new SseHub({ feeds: [feed], logger: silentLogger, heartbeatIntervalMs: 10_000 });
    hub.start();
    const client = hub.add(new FakeSink());
    let done = false;
    void client.closed.then(() => (done = true));
    hub.remove(client.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    hub.stop();
  });
});
