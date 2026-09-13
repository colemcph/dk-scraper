import { describe, expect, it } from 'vitest';
import { LatencyTracker, percentile } from '../src/server/feed/latency.js';

describe('LatencyTracker', () => {
  it('corrects for clock skew between DraftKings and this host', () => {
    const t = new LatencyTracker();
    // DraftKings' clock is 1,850 ms ahead of ours (what we measured in Ottawa).
    t.recordSkew(1850, 40);
    const created = Date.parse('2026-09-13T01:20:14.205Z');
    const sample = t.record(
      new Date(created).toISOString(),
      new Date(created + 62).toISOString(), // published 62 ms later on DK's clock
      new Date(created - 1850 + 250).toISOString(), // our clock: created (in our time) + 250 ms
    )!;
    expect(sample.dkPipelineMs).toBe(62);
    expect(sample.dkToServerMs).toBe(250);
    expect(sample.skewCorrected).toBe(true);
    expect(t.stats()).toMatchObject({
      samples: 1,
      p50Ms: 250,
      p95Ms: 250,
      lastMs: 250,
      clockSkewMs: 1850,
      skewRttMs: 40,
    });
  });

  it('never reports negative latency and works without a skew estimate', () => {
    const t = new LatencyTracker();
    const s = t.record(
      '2026-09-13T01:00:01.000Z',
      '2026-09-13T01:00:01.000Z',
      '2026-09-13T01:00:00.500Z',
    )!;
    expect(s.dkToServerMs).toBe(0);
    expect(s.skewCorrected).toBe(false);
  });

  it('keeps the tighter of recent skew samples', () => {
    const t = new LatencyTracker();
    t.recordSkew(1000, 40);
    t.recordSkew(5000, 400); // a sloppy round trip should not replace a tight one
    expect(t.stats().clockSkewMs).toBe(1000);
    t.recordSkew(1100, 45);
    expect(t.stats().clockSkewMs).toBe(1100);
  });

  it('computes percentiles over a bounded window', () => {
    const t = new LatencyTracker(5);
    const base = Date.parse('2026-09-13T01:00:00.000Z');
    for (let i = 1; i <= 10; i++) {
      t.record(
        new Date(base).toISOString(),
        new Date(base).toISOString(),
        new Date(base + i * 100).toISOString(),
      );
    }
    expect(t.stats().samples).toBe(5);
    expect(t.stats().p50Ms).toBe(800);
    expect(t.stats().p95Ms).toBe(1000);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([], 0.5)).toBe(0);
  });
});
