import WebSocket from 'ws';
import { errorMessage, type Logger } from '../../logger.js';
import type { LeagueRef, SocketState, Subscription, SubscriptionHandlers } from '../types.js';
import { normalizeUpdateFrame } from './normalize.js';
import { BROWSER_USER_AGENT } from './rest.js';
import { DkSocketFrame, DkUpdateFrame, type DkSubscriptionPartialT } from './schema.js';

/**
 * DraftKings' push feed ("Longshot"). Reverse-engineered from their web client's dk-data-layer:
 *
 *   wss://sportsbook-ws-{region}.draftkings.com/websocket?format=json&locale=en-US
 *   -> {"jsonrpc":"2.0","method":"subscribe","id":..., "params":{entity, queryParams, ...}}
 *   <- {"id":..., "event":"subscribed", "websocketPublishTimestamp": ...}
 *   <- {"id":..., "event":"update", "data":{"data":{add,change,remove}, "metadata":{createdTime,...}}, ...}
 *
 * It is a delta feed: after the ack you only get what changed. The caller must have a snapshot.
 * The site itself uses format=msgpack; the server also serves JSON, which we use.
 */

/** Minimal surface we need from `ws`, so tests can inject a fake. */
export interface SocketLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: WebSocket.RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'pong', cb: () => void): unknown;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export interface DkSocketOptions {
  region: string;
  site: string;
  locale?: string;
  league: LeagueRef;
  spec: DkSubscriptionPartialT;
  handlers: SubscriptionHandlers;
  logger: Logger;
  retryBaseMs?: number;
  retryMaxMs?: number;
  pingIntervalMs?: number;
  inactivityTimeoutMs?: number;
  connectTimeoutMs?: number;
  socketFactory?: SocketFactory;
  now?: () => number;
}

/** Close codes DraftKings' own client treats specially (from dk-data-layer). */
const TERMINAL_CLOSE = 4000; // bad query params (jwt/locale/format) — retrying fast is pointless

export class DkSocketClient implements Subscription {
  private socket: SocketLike | null = null;
  private stopped = false;
  private attempt = 0;
  private state: SocketState = 'idle';
  private subscribeSentAt: number | null = null;
  private lastActivityAt = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly subscriptionId: string;
  private readonly now: () => number;

  constructor(private readonly opts: DkSocketOptions) {
    this.subscriptionId = `league-${opts.league.id}-${opts.league.subcategoryId}`;
    this.now = opts.now ?? Date.now;
  }

  get url(): string {
    const locale = this.opts.locale ?? 'en-US';
    return `wss://sportsbook-ws-${this.opts.region}.draftkings.com/websocket?format=json&locale=${encodeURIComponent(locale)}`;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.socket) {
      try {
        this.socket.close(1000, 'client shutdown');
      } catch {
        /* already gone */
      }
      this.socket = null;
    }
    this.setState('closed');
  }

  /* ---------------------------------------------------------------------------------------- */

  private setState(state: SocketState, detail?: { code?: number; reason?: string }): void {
    if (this.state === state && !detail) return;
    this.state = state;
    this.opts.handlers.onState(state, detail);
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearTimers();
    const headers = {
      'User-Agent': BROWSER_USER_AGENT,
      Origin: 'https://sportsbook.draftkings.com',
    };
    const factory: SocketFactory =
      this.opts.socketFactory ??
      ((url, h) => new WebSocket(url, { headers: h, handshakeTimeout: 10_000 }));

    this.setState('connecting');
    let socket: SocketLike;
    try {
      socket = factory(this.url, headers);
    } catch (err) {
      this.opts.handlers.onError(err instanceof Error ? err : new Error(errorMessage(err)));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.lastActivityAt = this.now();

    this.connectTimer = setTimeout(() => {
      this.opts.logger.warn('socket connect timeout');
      this.terminate(socket);
    }, this.opts.connectTimeoutMs ?? 10_000);

    socket.on('open', () => this.onOpen(socket));
    socket.on('message', (data) => this.onMessage(socket, data));
    socket.on('pong', () => this.touch());
    socket.on('error', (err) => {
      this.opts.handlers.onError(new Error(`socket error: ${err.message}`));
    });
    socket.on('close', (code, reason) => this.onClose(socket, code, reason.toString()));
  }

  private onOpen(socket: SocketLike): void {
    if (socket !== this.socket) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.touch();
    this.setState('open');

    const { spec, league, site, locale } = this.opts;
    const message = {
      jsonrpc: '2.0',
      method: 'subscribe',
      id: this.subscriptionId,
      params: {
        entity: spec.entity,
        queryParams: {
          query: spec.query,
          ...(spec.includeMarkets ? { includeMarkets: spec.includeMarkets } : {}),
          initialData: false,
          projection: 'sportsbook',
          locale: locale ?? 'en-US',
        },
        forwardedHeaders: {},
        clientMetadata: {
          feature: 'league',
          'X-Client-Name': 'web',
          'X-Client-Version': 'unknown',
        },
        jwt: '',
        siteName: site,
      },
    };
    this.subscribeSentAt = this.now();
    socket.send(JSON.stringify(message));
    this.opts.logger.info('socket subscribe sent', { url: this.url, league: league.id, site });

    const interval = this.opts.pingIntervalMs ?? 15_000;
    this.pingTimer = setInterval(() => {
      const idle = this.now() - this.lastActivityAt;
      if (idle > (this.opts.inactivityTimeoutMs ?? 45_000)) {
        this.opts.logger.warn('socket inactive, forcing reconnect', { idleMs: idle });
        this.terminate(socket);
        return;
      }
      try {
        socket.ping();
      } catch {
        /* closing */
      }
    }, interval);
  }

  private onMessage(socket: SocketLike, data: WebSocket.RawData): void {
    if (socket !== this.socket) return;
    const receivedAtMs = this.now();
    this.touch(receivedAtMs);
    const receivedAt = new Date(receivedAtMs).toISOString();

    let json: unknown;
    try {
      json = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      this.opts.handlers.onError(new Error('socket sent non-JSON frame'));
      return;
    }
    const frame = DkSocketFrame.safeParse(json);
    if (!frame.success) {
      this.opts.handlers.onError(new Error('socket frame did not match any known shape'));
      return;
    }
    const f = frame.data;

    if ('error' in f && f.error !== undefined && f.error !== null) {
      this.opts.handlers.onError(
        new Error(`socket error frame: ${JSON.stringify(f.error as unknown).slice(0, 200)}`),
      );
      return;
    }
    if (!('event' in f)) return;

    switch (f.event) {
      case 'subscribed': {
        const sentAt = this.subscribeSentAt ?? receivedAtMs;
        const rttMs = Math.max(0, receivedAtMs - sentAt);
        const ts = f.websocketPublishTimestamp;
        const upstream = typeof ts === 'string' ? Date.parse(ts) : NaN;
        // NTP-style: DraftKings' clock at the ack ≈ our (send time + RTT/2).
        const skewMs = Number.isFinite(upstream) ? upstream - (sentAt + rttMs / 2) : 0;
        this.attempt = 0;
        this.setState('subscribed');
        this.opts.handlers.onAck({ rttMs, skewMs, at: receivedAt });
        break;
      }
      case 'update': {
        const parsed = DkUpdateFrame.safeParse(f);
        if (!parsed.success) {
          this.opts.handlers.onError(new Error('update frame failed validation'));
          return;
        }
        this.opts.handlers.onDelta(normalizeUpdateFrame(parsed.data, this.opts.league, receivedAt));
        break;
      }
      case 'unsubscribed':
        this.opts.logger.warn('socket reported unsubscribed; reconnecting');
        this.terminate(socket);
        break;
      default:
        this.opts.logger.debug('socket frame ignored', { event: f.event });
    }
  }

  private onClose(socket: SocketLike, code: number, reason: string): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearTimers();
    this.setState('closed', { code, reason });
    if (this.stopped) return;
    this.scheduleReconnect(code);
  }

  private scheduleReconnect(code?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = this.opts.retryBaseMs ?? 1_000;
    const max = this.opts.retryMaxMs ?? 30_000;
    const exp = Math.min(max, base * 2 ** Math.min(this.attempt, 10));
    const delay = code === TERMINAL_CLOSE ? max : Math.round(exp * (0.7 + Math.random() * 0.6));
    this.attempt++;
    this.opts.logger.info('socket reconnect scheduled', {
      delayMs: delay,
      attempt: this.attempt,
      code,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private terminate(socket: SocketLike): void {
    try {
      socket.terminate();
    } catch {
      /* ignore */
    }
  }

  private touch(at = this.now()): void {
    this.lastActivityAt = at;
    this.opts.handlers.onActivity(new Date(at).toISOString());
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.connectTimer = this.reconnectTimer = null;
  }
}
