/**
 * Browser clocks are not trustworthy, so we estimate (browser − server) NTP-style:
 * ask /api/time a few times, keep the sample with the tightest round trip, and assume the
 * server's timestamp corresponds to the midpoint of that request. Everything the UI shows as
 * "x seconds ago" or "server → you: n ms" is computed on the server's clock via this offset.
 */
export interface ClockOffset {
  /** browserNow - serverNow, in ms */
  offsetMs: number;
  rttMs: number;
  estimatedAt: number;
}

export async function estimateClockOffset(samples = 3): Promise<ClockOffset | null> {
  let best: ClockOffset | null = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch('/api/time', { cache: 'no-store' });
      const t1 = Date.now();
      if (!res.ok) continue;
      const body = (await res.json()) as { serverTimeMs?: number };
      if (typeof body.serverTimeMs !== 'number') continue;
      const rttMs = t1 - t0;
      const offsetMs = t0 + rttMs / 2 - body.serverTimeMs;
      if (!best || rttMs < best.rttMs) best = { offsetMs, rttMs, estimatedAt: t1 };
    } catch {
      /* try the next sample */
    }
  }
  return best;
}

/** Convert an ISO timestamp from the server's clock into "ms ago" on the browser's clock. */
export function serverAgoMs(
  iso: string | null | undefined,
  offsetMs: number,
  browserNow: number,
): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return browserNow - offsetMs - t;
}
