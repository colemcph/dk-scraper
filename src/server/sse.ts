import type { DeltaEvent, FeedMeta, HeartbeatEvent, OddsSnapshot } from '../shared/types.js';
import type { FeedManager } from './feed.js';
import type { Logger } from './logger.js';

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/** What the hub needs from a transport (Hono's SSEStreamingApi in production, a fake in tests). */
export interface SseSink {
  write(message: SseMessage): Promise<void>;
}

export interface SseClient {
  id: number;
  /** Resolves when the client is gone. */
  closed: Promise<void>;
}

interface ClientRecord extends SseClient {
  sink: SseSink;
  queue: Promise<void>;
  resolveClosed: () => void;
  alive: boolean;
}

export interface SseHubOptions {
  /** One FeedManager per book; every event carries `meta.book`. */
  feeds: FeedManager[];
  logger: Logger;
  heartbeatIntervalMs: number;
  replayBufferSize?: number;
  now?: () => number;
}

/**
 * Fans every book's FeedManager events out to every connected browser on one stream.
 *
 *  - On connect: a `snapshot` per book (full state), unless the client's Last-Event-ID is recent
 *    enough that we can replay the deltas it missed from a small ring buffer.
 *  - `delta` for every change. Ids are a hub-wide sequence (not the per-book store version, which
 *    would collide across books), so EventSource reconnects resume cleanly.
 *  - `meta` on feed state transitions and polls, `heartbeat` on a timer (client stale detection
 *    + clock offset), with every book's state in it.
 */
export class SseHub {
  private readonly clients = new Map<number, ClientRecord>();
  private readonly replay: { seq: number; data: string }[] = [];
  private seq = 0;
  private nextId = 1;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly opts: SseHubOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    for (const feed of this.opts.feeds) {
      this.unsubscribe.push(feed.on('delta', (e) => this.onDelta(e)));
      this.unsubscribe.push(feed.on('meta', (m) => this.onMeta(m)));
    }
    this.heartbeat = setInterval(() => this.sendHeartbeat(), this.opts.heartbeatIntervalMs);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const u of this.unsubscribe) u();
    this.unsubscribe.length = 0;
    for (const c of this.clients.values()) this.remove(c.id);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** The id of the latest delta sent (what a fresh client's snapshots are stamped with). */
  get sequence(): number {
    return this.seq;
  }

  add(sink: SseSink, lastEventId?: string): SseClient {
    let resolveClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const client: ClientRecord = {
      id: this.nextId++,
      sink,
      queue: Promise.resolve(),
      closed,
      resolveClosed,
      alive: true,
    };
    this.clients.set(client.id, client);
    this.opts.logger.debug('sse client connected', { id: client.id, clients: this.clients.size });
    this.sendInitial(client, lastEventId);
    return client;
  }

  remove(id: number): void {
    const client = this.clients.get(id);
    if (!client) return;
    client.alive = false;
    this.clients.delete(id);
    client.resolveClosed();
    this.opts.logger.debug('sse client disconnected', { id, clients: this.clients.size });
  }

  /* ---------------------------------------------------------------------------------------- */

  private sendInitial(client: ClientRecord, lastEventId?: string): void {
    const wanted = lastEventId ? Number.parseInt(lastEventId, 10) : NaN;
    const oldest = this.replay[0]?.seq;

    if (
      Number.isFinite(wanted) &&
      oldest !== undefined &&
      wanted >= oldest - 1 &&
      wanted < this.seq
    ) {
      // Resume: replay only what this client missed.
      for (const entry of this.replay) {
        if (entry.seq > wanted)
          this.send(client, { event: 'delta', data: entry.data, id: String(entry.seq) });
      }
      return;
    }
    for (const feed of this.opts.feeds) {
      const snapshot: OddsSnapshot = feed.snapshot();
      this.send(client, {
        event: 'snapshot',
        data: JSON.stringify(snapshot),
        id: String(this.seq),
        retry: 2_000,
      });
    }
  }

  private onDelta(event: DeltaEvent): void {
    const data = JSON.stringify(event);
    this.seq++;
    this.replay.push({ seq: this.seq, data });
    const max = this.opts.replayBufferSize ?? 200;
    while (this.replay.length > max) this.replay.shift();
    this.broadcast({ event: 'delta', data, id: String(this.seq) });
  }

  private onMeta(meta: FeedMeta): void {
    this.broadcast({ event: 'meta', data: JSON.stringify(meta) });
  }

  private sendHeartbeat(): void {
    const payload: HeartbeatEvent = {
      serverTime: new Date(this.now()).toISOString(),
      books: this.opts.feeds.map((feed) => {
        const meta = feed.meta();
        return {
          book: meta.book,
          version: meta.version,
          feedState: meta.feedState,
          stale: meta.stale,
          lastContactAt: meta.lastContactAt,
        };
      }),
    };
    this.broadcast({ event: 'heartbeat', data: JSON.stringify(payload) });
  }

  private broadcast(message: SseMessage): void {
    for (const client of this.clients.values()) this.send(client, message);
  }

  private send(client: ClientRecord, message: SseMessage): void {
    if (!client.alive) return;
    client.queue = client.queue
      .then(() => client.sink.write(message))
      .catch((err: unknown) => {
        this.opts.logger.debug('sse write failed; dropping client', {
          id: client.id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.remove(client.id);
      });
  }
}
