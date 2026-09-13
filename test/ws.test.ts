import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DkSocketClient, type SocketLike } from '../src/server/books/draftkings/ws.js';
import { defaultSubscriptionSpec } from '../src/server/books/draftkings/normalize.js';
import type {
  NormalizedDelta,
  SocketState,
  SubscriptionHandlers,
} from '../src/server/books/types.js';
import { silentLogger } from '../src/server/logger.js';
import { fixture } from './helpers.js';

type Handler = (...args: unknown[]) => void;

class FakeSocket implements SocketLike {
  sent: string[] = [];
  pings = 0;
  closed: { code?: number; reason?: string } | null = null;
  terminated = false;
  private handlers = new Map<string, Handler[]>();

  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pings++;
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.terminated = true;
    this.emit('close', 1006, Buffer.from(''));
  }
}

const MLB = { id: '84240', name: 'MLB', subcategoryId: '4519' };

function harness() {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const states: SocketState[] = [];
  const deltas: NormalizedDelta[] = [];
  const acks: Array<{ rttMs: number; skewMs: number }> = [];
  const errors: string[] = [];
  const handlers: SubscriptionHandlers = {
    onDelta: (d) => deltas.push(d),
    onState: (s) => states.push(s),
    onAck: (a) => acks.push({ rttMs: a.rttMs, skewMs: a.skewMs }),
    onActivity: () => {},
    onError: (e) => errors.push(e.message),
  };
  const client = new DkSocketClient({
    region: 'ca-on',
    site: 'dkcaon',
    league: MLB,
    spec: defaultSubscriptionSpec(MLB),
    handlers,
    logger: silentLogger,
    retryBaseMs: 1000,
    retryMaxMs: 30000,
    pingIntervalMs: 15000,
    inactivityTimeoutMs: 45000,
    socketFactory: (url) => {
      urls.push(url);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  return { client, sockets, urls, states, deltas, acks, errors };
}

describe('DkSocketClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T01:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('connects to the region host with format=json and sends a JSON-RPC subscribe on open', () => {
    const h = harness();
    h.client.start();
    expect(h.urls[0]).toBe(
      'wss://sportsbook-ws-ca-on.draftkings.com/websocket?format=json&locale=en-US',
    );
    h.sockets[0]!.emit('open');
    const msg = JSON.parse(h.sockets[0]!.sent[0]!);
    expect(msg).toMatchObject({
      jsonrpc: '2.0',
      method: 'subscribe',
      params: {
        entity: 'events',
        queryParams: { initialData: false, projection: 'sportsbook', locale: 'en-US' },
        jwt: '',
        siteName: 'dkcaon',
      },
    });
    expect(msg.params.queryParams.query).toContain("leagueId eq '84240'");
    expect(h.states).toEqual(['connecting', 'open']);
  });

  it('estimates clock skew NTP-style from the subscribe ack', () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.emit('open'); // sent at T
    vi.advanceTimersByTime(40); // ack arrives 40 ms later
    const dkNow = new Date(Date.now() + 2000 - 20).toISOString(); // DK clock 2 s ahead, stamped mid-flight
    h.sockets[0]!.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          id: 'league-84240-4519',
          event: 'subscribed',
          data: '',
          websocketPublishTimestamp: dkNow,
        }),
      ),
    );
    expect(h.acks).toEqual([{ rttMs: 40, skewMs: 2000 }]);
    expect(h.states.at(-1)).toBe('subscribed');
  });

  it('normalizes update frames and surfaces malformed ones as errors, not crashes', () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.emit('open');
    const { frames } = fixture<{ frames: Record<string, unknown> }>('dk-socket-frames.json');
    h.sockets[0]!.emit('message', Buffer.from(JSON.stringify(frames.selectionChange)));
    expect(h.deltas).toHaveLength(1);
    expect(h.deltas[0]!.selections.upsert[0]!.sourceSelectionId).toBe('0ML86275348_1');

    h.sockets[0]!.emit('message', Buffer.from('not json'));
    h.sockets[0]!.emit(
      'message',
      Buffer.from(JSON.stringify({ id: 'x', error: { code: 42, message: 'nope' } })),
    );
    expect(h.errors).toHaveLength(2);
    // A frame of an unknown-but-harmless shape is ignored rather than treated as an error.
    h.sockets[0]!.emit('message', Buffer.from(JSON.stringify({ totally: 'unexpected' })));
    expect(h.errors).toHaveLength(2);
    expect(h.deltas).toHaveLength(1);
  });

  it('reconnects with exponential backoff and resets after a successful subscribe', () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.emit('close', 1006, Buffer.from('boom'));
    expect(h.states.at(-1)).toBe('closed');
    expect(h.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1000 * 1.3 + 1); // first retry: ~1 s (with jitter up to 1.3x)
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.emit('close', 1006, Buffer.from(''));
    vi.advanceTimersByTime(1000 * 1.3);
    expect(h.sockets).toHaveLength(2); // second retry waits ~2 s
    vi.advanceTimersByTime(1000 * 1.3);
    expect(h.sockets).toHaveLength(3);

    h.sockets[2]!.emit('open');
    h.sockets[2]!.emit(
      'message',
      Buffer.from(JSON.stringify({ id: 'league-84240-4519', event: 'subscribed', data: '' })),
    );
    h.sockets[2]!.emit('close', 1000, Buffer.from('Session Terminated'));
    vi.advanceTimersByTime(1000 * 1.3 + 1); // backoff reset -> ~1 s again
    expect(h.sockets).toHaveLength(4);
  });

  it('forces a reconnect when the socket goes silent', () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.emit('open');
    vi.advanceTimersByTime(15000);
    expect(h.sockets[0]!.pings).toBe(1);
    vi.advanceTimersByTime(45000);
    expect(h.sockets[0]!.terminated).toBe(true);
  });

  it('stops cleanly and does not reconnect after close()', () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.emit('open');
    h.client.close();
    expect(h.sockets[0]!.closed?.code).toBe(1000);
    vi.advanceTimersByTime(60000);
    expect(h.sockets).toHaveLength(1);
  });
});
