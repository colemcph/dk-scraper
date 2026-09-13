import type { LatencyStats, UpdateLatency } from '../../shared/types.js';

/**
 * "How old is the number on the screen?" needs three clocks to agree: DraftKings', ours and the
 * browser's. DraftKings stamps every delta with `createdTime` (odds engine) and
 * `websocketPublishTimestamp` (socket layer). We estimate our offset from DraftKings NTP-style
 * from the subscribe round trip (their ack carries their time; RTT/2 is the uncertainty), then
 * report `createdTime -> our receipt` corrected by that offset. The browser does the same trick
 * against `/api/time`.
 */
export class LatencyTracker {
  private samples: number[] = [];
  private skewMs: number | null = null;
  private skewRttMs: number | null = null;
  private last: number | null = null;

  constructor(private readonly maxSamples = 1000) {}

  /** Called on every subscribe ack. Keeps the estimate from the tightest round trip we've seen recently. */
  recordSkew(skewMs: number, rttMs: number): void {
    // A large RTT makes the estimate mushy; prefer the tighter of the last two.
    if (this.skewRttMs === null || rttMs <= this.skewRttMs * 1.5) {
      this.skewMs = Math.round(skewMs);
      this.skewRttMs = Math.round(rttMs);
    }
  }

  /** Builds the latency record for one delta and folds it into the stats. */
  record(createdAt: string, publishedAt: string, receivedAt: string): UpdateLatency | undefined {
    const created = Date.parse(createdAt);
    const published = Date.parse(publishedAt);
    const received = Date.parse(receivedAt);
    if (![created, published, received].every(Number.isFinite)) return undefined;

    const skew = this.skewMs ?? 0;
    const dkToServerMs = Math.max(0, Math.round(received - (created - skew)));
    const dkPipelineMs = Math.max(0, Math.round(published - created));

    this.samples.push(dkToServerMs);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    this.last = dkToServerMs;

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
    if (this.samples.length === 0) {
      return {
        samples: 0,
        p50Ms: null,
        p95Ms: null,
        lastMs: null,
        clockSkewMs: this.skewMs,
        skewRttMs: this.skewRttMs,
      };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      samples: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      lastMs: this.last,
      clockSkewMs: this.skewMs,
      skewRttMs: this.skewRttMs,
    };
  }

  reset(): void {
    this.samples = [];
    this.last = null;
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? 0;
}
