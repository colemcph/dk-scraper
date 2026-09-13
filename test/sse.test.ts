import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedManager } from '../src/server/feed/feedManager.js';
import { silentLogger } from '../src/server/logger.js';
import { SseHub, type SseMessage } from '../src/server/sse/hub.js';
import type { DeltaEvent, FeedMeta, OddsSnapshot } from '../src/shared/types.js';
import { game } from './helpers.js';

/** Just enough of a FeedManager for the hub: event registration + snapshot/meta getters. */
function fakeFeed() {
  const listeners = {
    delta: new Set<(d: DeltaEvent) => void>(),
    meta: new Set<(m: FeedMeta) => void>(),
  };
  let version = 1;
  const meta = (): FeedMeta =>
    ({
      feedState: 'live',
      stale: false,
      version,
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
    on(event: 'delta' | 'meta', l: (x: never) => void) {
      (listeners[event] as Set<(x: never) => void>).add(l);
      return () => (listeners[event] as Set<(x: never) => void>).delete(l);
    },
    snapshot: (): OddsSnapshot => ({ version, games: [game('g1')], meta: meta() }),
    meta,
  } as unknown as FeedManager;
  const emitDelta = (changes = 0) => {
    version++;
    const d: DeltaEvent = {
      version,
      games: [game('g1')],
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
  return { feed, emitDelta };
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

  it('sends a snapshot on connect and deltas as they happen, with version ids', async () => {
    const { feed, emitDelta } = fakeFeed();
    const hub = new SseHub({ feed, logger: silentLogger, heartbeatIntervalMs: 10_000 });
    hub.start();
    const sink = new FakeSink();
    hub.add(sink);
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.messages[0]).toMatchObject({ event: 'snapshot', id: '1', retry: 2000 });
    expect(JSON.parse(sink.messages[0]!.data).games).toHaveLength(1);

    emitDelta();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.messages[1]).toMatchObject({ event: 'delta', id: '2' });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sink.messages.at(-1)!.event).toBe('heartbeat');
    expect(JSON.parse(sink.messages.at(-1)!.data)).toMatchObject({ version: 2, feedState: 'live' });
    hub.stop();
  });

  it('replays missed deltas for a reconnecting client with Last-Event-ID, else resends a snapshot', async () => {
    const { feed, emitDelta } = fakeFeed();
    const hub = new SseHub({
      feed,
      logger: silentLogger,
      heartbeatIntervalMs: 10_000,
      replayBufferSize: 3,
    });
    hub.start();
    emitDelta(); // v2
    emitDelta(); // v3
    emitDelta(); // v4

    const resume = new FakeSink();
    hub.add(resume, '2');
    await vi.advanceTimersByTimeAsync(0);
    expect(resume.messages.map((m) => `${m.event}:${m.id}`)).toEqual(['delta:3', 'delta:4']);

    const tooOld = new FakeSink();
    emitDelta(); // v5 -> buffer now holds 3,4,5; a client at v1 can't be caught up
    hub.add(tooOld, '1');
    await vi.advanceTimersByTimeAsync(0);
    expect(tooOld.messages[0]!.event).toBe('snapshot');

    const current = new FakeSink();
    hub.add(current, '5');
    await vi.advanceTimersByTimeAsync(0);
    expect(current.messages[0]!.event).toBe('snapshot'); // up to date: a fresh snapshot is cheap and safe
    hub.stop();
  });

  it('drops clients whose writes fail', async () => {
    const { feed, emitDelta } = fakeFeed();
    const hub = new SseHub({ feed, logger: silentLogger, heartbeatIntervalMs: 10_000 });
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
    const hub = new SseHub({ feed, logger: silentLogger, heartbeatIntervalMs: 10_000 });
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
