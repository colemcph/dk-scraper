import type { DeltaEvent, FeedMeta, HeartbeatEvent, OddsSnapshot } from '../../shared/types.js';
import type { FeedManager } from '../feed/feedManager.js';
import type { Logger } from '../logger.js';

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
  feed: FeedManager;
  logger: Logger;
  heartbeatIntervalMs: number;
  replayBufferSize?: number;
  now?: () => number;
}

/**
 * Fans FeedManager events out to every connected browser.
 *
 *  - On connect: `snapshot` (full state), unless the client's Last-Event-ID is recent enough that
 *    we can replay the deltas it missed from a small ring buffer.
 *  - `delta` for every change (id = store version, so EventSource reconnects resume cleanly).
 *  - `meta` on feed state transitions, `heartbeat` on a timer (client stale detection + clock offset).
 */
export class SseHub {
  private readonly clients = new Map<number, ClientRecord>();
  private readonly replay: { version: number; data: string }[] = [];
  private nextId = 1;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly opts: SseHubOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.unsubscribe.push(this.opts.feed.on('delta', (e) => this.onDelta(e)));
    this.unsubscribe.push(this.opts.feed.on('meta', (m) => this.onMeta(m)));
    this.heartbeat = setInterval(() => this.sendHeartbeat(), this.opts.heartbeatIntervalMs);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const u of this.unsubscribe) u();
    for (const c of this.clients.values()) this.remove(c.id);
  }

  get clientCount(): number {
    return this.clients.size;
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
    const snapshot: OddsSnapshot = this.opts.feed.snapshot();
    const wanted = lastEventId ? Number.parseInt(lastEventId, 10) : NaN;
    const oldest = this.replay[0]?.version;

    if (
      Number.isFinite(wanted) &&
      oldest !== undefined &&
      wanted >= oldest - 1 &&
      wanted < snapshot.version
    ) {
      // Resume: replay only what this client missed.
      for (const entry of this.replay) {
        if (entry.version > wanted)
          this.send(client, { event: 'delta', data: entry.data, id: String(entry.version) });
      }
      return;
    }
    this.send(client, {
      event: 'snapshot',
      data: JSON.stringify(snapshot),
      id: String(snapshot.version),
      retry: 2_000,
    });
  }

  private onDelta(event: DeltaEvent): void {
    const data = JSON.stringify(event);
    this.replay.push({ version: event.version, data });
    const max = this.opts.replayBufferSize ?? 200;
    while (this.replay.length > max) this.replay.shift();
    this.broadcast({ event: 'delta', data, id: String(event.version) });
  }

  private onMeta(meta: FeedMeta): void {
    this.broadcast({ event: 'meta', data: JSON.stringify(meta) });
  }

  private sendHeartbeat(): void {
    const meta = this.opts.feed.meta();
    const payload: HeartbeatEvent = {
      serverTime: new Date(this.now()).toISOString(),
      version: meta.version,
      feedState: meta.feedState,
      stale: meta.stale,
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
