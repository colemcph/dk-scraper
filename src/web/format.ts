import type { BookId, MarketType, Odds, SideKey } from '../shared/types.js';

export type OddsFormat = 'american' | 'decimal';

export const BOOK_SHORT: Record<BookId, string> = { draftkings: 'DK', fanduel: 'FD' };

export function formatOdds(odds: Odds, format: OddsFormat): string {
  if (format === 'decimal') return odds.decimal.toFixed(2);
  return odds.american > 0 ? `+${odds.american}` : String(odds.american);
}

export function formatLine(market: MarketType, side: SideKey, line: number | undefined): string {
  if (line === undefined) return '';
  if (market === 'total') return `${side === 'over' ? 'O' : 'U'} ${line}`;
  if (market === 'spread') {
    if (line === 0) return 'PK';
    return line > 0 ? `+${line}` : String(line);
  }
  return '';
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const clockFmt = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatKickoff(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function formatDayHeading(iso: string): string {
  return dayFmt.format(new Date(iso));
}

/** Stable per-day grouping key in the viewer's timezone (YYYY-MM-DD). */
export function dayKey(iso: string): string {
  return dayKeyFmt.format(new Date(iso));
}

export function formatClock(iso: string): string {
  return clockFmt.format(new Date(iso));
}

export function localTimeZoneLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(
      new Date(),
    );
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** "3s ago", "2m ago", "1h ago" */
export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** "30 s", "1.5 s" */
export function formatSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = ms / 1000;
  return Number.isInteger(s) ? `${s} s` : `${s.toFixed(1)} s`;
}

/** 0.524 -> "52.4%" */
export function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Nearest-rank percentile; null for an empty sample. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? null;
}

export const MARKET_LABEL: Record<MarketType, string> = {
  moneyline: 'Moneyline',
  spread: 'Spread',
  total: 'Total',
};
