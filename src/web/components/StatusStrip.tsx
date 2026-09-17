import type { BookId, FeedMeta } from '../../shared/types.js';
import type { Connection } from '../useOddsFeed.js';
import { formatAgo, formatClock, formatMs, formatSeconds, type OddsFormat } from '../format.js';
import { serverAgoMs } from '../timeSync.js';
import { BookBadge } from './BookBadge.js';

export interface BookEntry {
  book: BookId;
  meta: FeedMeta | null;
}

interface Props {
  books: BookEntry[];
  connection: Connection;
  clockOffsetMs: number | null;
  browserNow: number;
  browserLegP50: number | null;
  refreshing: boolean;
  refreshNote: string | null;
  onRefresh: () => void;
  format: OddsFormat;
  onFormat: (f: OddsFormat) => void;
}

export interface DisplayState {
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  detail: string;
}

export function displayState(meta: FeedMeta | null, connection: Connection): DisplayState {
  if (connection !== 'open') {
    return {
      label: connection === 'connecting' ? 'CONNECTING' : 'RECONNECTING',
      tone: 'warn',
      detail: 'to this server',
    };
  }
  if (!meta) return { label: 'CONNECTING', tone: 'neutral', detail: '' };
  const name = meta.bookName;
  if (meta.stale) return { label: 'STALE', tone: 'bad', detail: `no contact with ${name}` };
  switch (meta.feedState) {
    case 'live':
      return { label: 'LIVE', tone: 'good', detail: `${name} push feed` };
    case 'polling':
      // Healthy for a book with no push feed; a fallback for one that has.
      return meta.transport === 'poll'
        ? {
            label: 'POLLING',
            tone: 'good',
            detail: `${name} has no push feed; cache-aware polling`,
          }
        : {
            label: 'POLLING',
            tone: 'warn',
            detail: 'socket unavailable · snapshot every few seconds',
          };
    case 'reconnecting':
      return { label: 'RECONNECTING', tone: 'warn', detail: `${name} socket dropped` };
    case 'degraded':
      return {
        label: 'DEGRADED',
        tone: 'bad',
        detail: `${name} unreachable · showing last known odds`,
      };
    default:
      return { label: 'STARTING', tone: 'neutral', detail: 'loading first snapshot' };
  }
}

/**
 * The honest bound on how old a poll-only book's number can be: the CDN may serve a copy up to
 * max-age old, and we look again within one poll interval of it changing. With the cache
 * bypassed it is one interval plus the request itself.
 */
export function freshnessBoundMs(meta: FeedMeta): number | null {
  const p = meta.poll;
  if (!p) return null;
  if (p.bypassCache) return p.intervalMs + (p.p50Ms ?? 0);
  return (p.cacheMaxAgeMs ?? 0) + p.intervalMs;
}

function BookStatus({
  entry,
  connection,
  offset,
  browserNow,
  browserLegP50,
}: {
  entry: BookEntry;
  connection: Connection;
  offset: number;
  browserNow: number;
  browserLegP50: number | null;
}) {
  const { book, meta } = entry;
  const state = displayState(meta, connection);
  const contactAgo = serverAgoMs(meta?.lastContactAt, offset, browserNow);
  const changeAgo = serverAgoMs(meta?.lastChangeAt, offset, browserNow);
  const lat = meta?.latency;
  const live = meta?.feedState === 'live';
  const endToEndP50 = !live
    ? null
    : lat?.p50Ms != null && browserLegP50 != null
      ? lat.p50Ms + browserLegP50
      : (lat?.p50Ms ?? null);
  const name = meta?.bookName ?? book;

  return (
    <div className="status-book">
      <BookBadge book={book} />
      <span className={`pill pill--${state.tone}`} title={state.detail}>
        <span className="pill-dot" /> {state.label}
      </span>
      <span
        className="status-item"
        title={`Last successful exchange with ${name} (socket message, ack, snapshot or 304)`}
      >
        contact <strong>{contactAgo === null ? '—' : formatAgo(contactAgo)}</strong>
      </span>
      <span className="status-item" title="Last time a moneyline / spread / total changed">
        last move{' '}
        <strong>
          {meta?.lastChangeAt
            ? `${formatClock(meta.lastChangeAt)} (${formatAgo(changeAgo ?? 0)})`
            : 'none yet'}
        </strong>
      </span>
      {meta?.transport === 'poll' ? (
        <span
          className="status-item"
          title={`${name} publishes no timestamps and has no push feed. Its page API sits behind a CDN cache (max-age ${formatSeconds(meta.poll?.cacheMaxAgeMs)}); this is the most a number here can lag ${name}'s public API: cache max-age + one poll interval. Details in the latency panel.`}
        >
          freshness <strong>≤ {formatSeconds(freshnessBoundMs(meta))}</strong>
        </span>
      ) : (
        <span
          className="status-item"
          title={`${name} odds engine → your screen. p50 over recent updates, clock-skew corrected. Details in the latency panel.`}
        >
          {name === 'DraftKings' ? 'DK' : name} → screen{' '}
          <strong>{live ? formatMs(endToEndP50) : 'n/a (polling)'}</strong>
          {live && lat?.p95Ms != null && (
            <span className="muted"> · p95 {formatMs(lat.p95Ms + (browserLegP50 ?? 0))}</span>
          )}
        </span>
      )}
    </div>
  );
}

export function StatusStrip(props: Props) {
  const { books, connection, clockOffsetMs, browserNow } = props;
  const offset = clockOffsetMs ?? 0;
  const connecting = displayState(null, connection);

  return (
    <div className="status-strip">
      <div className="status-left">
        {books.length === 0 && (
          <span className={`pill pill--${connecting.tone}`} title={connecting.detail}>
            <span className="pill-dot" /> {connecting.label}
          </span>
        )}
        {books.map((entry) => (
          <BookStatus
            key={entry.book}
            entry={entry}
            connection={connection}
            offset={offset}
            browserNow={browserNow}
            browserLegP50={props.browserLegP50}
          />
        ))}
      </div>
      <div className="status-right">
        <div className="segmented" role="group" aria-label="Odds format">
          <button
            className={props.format === 'american' ? 'active' : ''}
            onClick={() => props.onFormat('american')}
          >
            American
          </button>
          <button
            className={props.format === 'decimal' ? 'active' : ''}
            onClick={() => props.onFormat('decimal')}
          >
            Decimal
          </button>
        </div>
        <button
          className="btn-refresh"
          onClick={props.onRefresh}
          disabled={props.refreshing}
          title="Force a fresh snapshot from every book"
        >
          {props.refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        {props.refreshNote && <span className="refresh-note">{props.refreshNote}</span>}
      </div>
    </div>
  );
}
