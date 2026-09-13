import type { LatencyStats, UpdateLatency } from '../../shared/types.js';

/**
 * "How old is the number on the screen?" needs three clocks to agree: DraftKings', ours and the
 * browser's. DraftKings stamps every delta with `createdTime` (odds engine) and
 * `websocketPublishTimestamp` (socket layer). We estimate our offset from DraftKings two ways:
 *
 *  1. Anchor: NTP-style from the subscribe round trip — their ack carries their time and we
 *     assume it corresponds to our send time + RTT/2.
 *  2. Tracked: every frame gives `d = ourReceipt − theirPublish = −skew + oneWay + queueing`.
 *     Over a window, min(d) ≈ −skew + oneWayMin, and oneWayMin ≈ RTT/2, so
 *     skew ≈ RTT/2 − min(d). This keeps working if the host clock steps mid-session (which
 *     happened on the dev laptop) and is what the UI reports once enough frames have arrived.
 *
 * The self-check: after correction, the network leg (publish → receipt) must be small and never
 * negative. The count of negative samples is exposed so the page can prove its own numbers.
 */
export class LatencyTracker {
  private totals: number[] = [];
  private pipelines: number[] = [];
  private transports: number[] = [];
  /** raw (receipt − publish) samples with our-clock timestamps, for the tracked skew */
  private window: { d: number; at: number }[] = [];
  private ackSkewMs: number | null = null;
  private ackRttMs: number | null = null;
  private negativeTransport = 0;
  private last: number | null = null;

  constructor(
    private readonly maxSamples = 1000,
    private readonly trackWindowMs = 10 * 60_000,
    private readonly minTrackSamples = 10,
  ) {}

  /** Called on every subscribe ack. Keeps the tightest round trip seen as the anchor. */
  recordSkew(skewMs: number, rttMs: number): void {
    if (this.ackRttMs === null || rttMs <= this.ackRttMs * 1.5) {
      this.ackSkewMs = Math.round(skewMs);
      this.ackRttMs = Math.round(rttMs);
    }
    if (this.ackRttMs !== null) this.ackRttMs = Math.min(this.ackRttMs, Math.round(rttMs));
  }

  /** Current best estimate of (DraftKings clock − our clock). */
  get skewMs(): number | null {
    return this.trackedSkew() ?? this.ackSkewMs;
  }

  get skewSource(): 'tracked' | 'ack' | null {
    if (this.trackedSkew() !== null) return 'tracked';
    return this.ackSkewMs === null ? null : 'ack';
  }

  private trackedSkew(): number | null {
    if (this.ackRttMs === null || this.window.length < this.minTrackSamples) return null;
    let minD = Infinity;
    for (const s of this.window) if (s.d < minD) minD = s.d;
    return Math.round(this.ackRttMs / 2 - minD);
  }

  /** Builds the latency record for one delta and folds it into the stats. */
  record(createdAt: string, publishedAt: string, receivedAt: string): UpdateLatency | undefined {
    const created = Date.parse(createdAt);
    const published = Date.parse(publishedAt);
    const received = Date.parse(receivedAt);
    if (![created, published, received].every(Number.isFinite)) return undefined;

    const skew = this.skewMs ?? 0;
    const dkPipelineMs = Math.max(0, Math.round(published - created));
    const transportMs = Math.round(received - (published - skew));
    const dkToServerMs = Math.max(0, Math.round(received - (created - skew)));

    if (transportMs < 0) this.negativeTransport++;
    this.push(this.totals, dkToServerMs);
    this.push(this.pipelines, dkPipelineMs);
    this.push(this.transports, transportMs);
    this.last = dkToServerMs;

    this.window.push({ d: received - published, at: received });
    const cutoff = received - this.trackWindowMs;
    while (this.window.length > 0 && (this.window[0]!.at < cutoff || this.window.length > 500)) {
      this.window.shift();
    }

    return {
      dkCreatedAt: createdAt,
      dkPublishedAt: publishedAt,
      serverReceivedAt: receivedAt,
      dkPipelineMs,
      dkToServerMs,
      skewCorrected: this.skewMs !== null,
    };
  }

  stats(): LatencyStats {
    const sorted = [...this.totals].sort((a, b) => a - b);
    const pipelines = [...this.pipelines].sort((a, b) => a - b);
    const transports = [...this.transports].sort((a, b) => a - b);
    return {
      samples: sorted.length,
      p50Ms: sorted.length ? percentile(sorted, 0.5) : null,
      p95Ms: sorted.length ? percentile(sorted, 0.95) : null,
      lastMs: this.last,
      pipelineP50Ms: pipelines.length ? percentile(pipelines, 0.5) : null,
      transportP50Ms: transports.length ? percentile(transports, 0.5) : null,
      transportMinMs: transports.length ? (transports[0] ?? null) : null,
      negativeTransportSamples: this.negativeTransport,
      clockSkewMs: this.skewMs,
      skewSource: this.skewSource,
      skewRttMs: this.ackRttMs,
    };
  }

  reset(): void {
    this.totals = [];
    this.pipelines = [];
    this.transports = [];
    this.window = [];
    this.negativeTransport = 0;
    this.last = null;
  }

  private push(arr: number[], v: number): void {
    arr.push(v);
    if (arr.length > this.maxSamples) arr.shift();
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? 0;
}
