import { describe, expect, it } from 'vitest';
import { LatencyTracker, percentile } from '../src/server/latency.js';

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
      pipelineP50Ms: 62,
      transportP50Ms: 188,
      negativeTransportSamples: 0,
      clockSkewMs: 1850,
      skewSource: 'ack',
      skewRttMs: 40,
    });
    expect(t.stats().byPhase.pregame.samples).toBe(1);
    expect(t.stats().byPhase.inplay.samples).toBe(0);
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

  it('refines the skew continuously from frame timestamps and survives a clock step', () => {
    const t = new LatencyTracker(1000, 10 * 60_000, 5);
    t.recordSkew(2000, 40); // anchor from the ack: DK is 2.0 s ahead
    const dk = Date.parse('2026-09-13T01:00:00.000Z');
    // Frames arrive with a true one-way delay of 20 ms, and the *real* skew is 2,000 ms.
    for (let i = 0; i < 6; i++) {
      const published = dk + i * 1000;
      const received = published - 2000 + 20; // our clock
      t.record(
        new Date(published - 30).toISOString(),
        new Date(published).toISOString(),
        new Date(received).toISOString(),
      );
    }
    expect(t.stats().skewSource).toBe('tracked');
    expect(t.stats().clockSkewMs).toBe(2000);
    expect(t.stats().negativeTransportSamples).toBe(0);

    // Our clock steps forward by 500 ms mid-session (skew is now 1,500 ms). The anchor would
    // over-correct and produce negative transport; the tracked estimate follows the frames.
    for (let i = 6; i < 20; i++) {
      const published = dk + i * 1000;
      const received = published - 1500 + 20;
      t.record(
        new Date(published - 30).toISOString(),
        new Date(published).toISOString(),
        new Date(received).toISOString(),
      );
    }
    expect(t.stats().clockSkewMs).toBe(2000); // min(d) still remembers the pre-step frames...
    // ...until they age out of the window: replay the post-step frames with later timestamps.
    for (let i = 0; i < 12; i++) {
      const published = dk + 11 * 60_000 + i * 1000;
      const received = published - 1500 + 20;
      t.record(
        new Date(published - 30).toISOString(),
        new Date(published).toISOString(),
        new Date(received).toISOString(),
      );
    }
    expect(t.stats().clockSkewMs).toBe(1500);
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
