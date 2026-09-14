import type { FeedMeta } from '../../shared/types.js';
import type { Connection } from '../useOddsFeed.js';
import { formatAgo, formatClock, formatMs, type OddsFormat } from '../format.js';
import { serverAgoMs } from '../timeSync.js';

interface Props {
  meta: FeedMeta | null;
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
  if (meta.stale) return { label: 'STALE', tone: 'bad', detail: 'no contact with DraftKings' };
  switch (meta.feedState) {
    case 'live':
      return { label: 'LIVE', tone: 'good', detail: 'DraftKings push feed' };
    case 'polling':
      return {
        label: 'POLLING',
        tone: 'warn',
        detail: 'socket unavailable · snapshot every few seconds',
      };
    case 'reconnecting':
      return { label: 'RECONNECTING', tone: 'warn', detail: 'DraftKings socket dropped' };
    case 'degraded':
      return {
        label: 'DEGRADED',
        tone: 'bad',
        detail: 'DraftKings unreachable · showing last known odds',
      };
    default:
      return { label: 'STARTING', tone: 'neutral', detail: 'loading first snapshot' };
  }
}

export function StatusStrip(props: Props) {
  const { meta, connection, clockOffsetMs, browserNow } = props;
  const state = displayState(meta, connection);
  const offset = clockOffsetMs ?? 0;
  const contactAgo = serverAgoMs(meta?.lastContactAt, offset, browserNow);
  const changeAgo = serverAgoMs(meta?.lastChangeAt, offset, browserNow);
  const lat = meta?.latency;
  const live = meta?.feedState === 'live';
  const endToEndP50 = !live
    ? null
    : lat?.p50Ms != null && props.browserLegP50 != null
      ? lat.p50Ms + props.browserLegP50
      : (lat?.p50Ms ?? null);

  return (
    <div className="status-strip">
      <div className="status-left">
        <span className={`pill pill--${state.tone}`} title={state.detail}>
          <span className="pill-dot" /> {state.label}
        </span>
        <span
          className="status-item"
          title="Last successful exchange with DraftKings (socket message, ack or snapshot)"
        >
          DraftKings contact <strong>{contactAgo === null ? '—' : formatAgo(contactAgo)}</strong>
        </span>
        <span className="status-item" title="Last time a moneyline / spread / total changed">
          Last line move{' '}
          <strong>
            {meta?.lastChangeAt
              ? `${formatClock(meta.lastChangeAt)} (${formatAgo(changeAgo ?? 0)})`
              : 'none yet'}
          </strong>
        </span>
        <span
          className="status-item"
          title="DraftKings odds engine → your screen. p50 over recent updates, clock-skew corrected. Details in the latency panel."
        >
          DK → screen <strong>{live ? formatMs(endToEndP50) : 'n/a (polling)'}</strong>
          {live && lat?.p95Ms != null && (
            <span className="muted"> · p95 {formatMs(lat.p95Ms + (props.browserLegP50 ?? 0))}</span>
          )}
        </span>
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
          title="Force a fresh snapshot from DraftKings"
        >
          {props.refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        {props.refreshNote && <span className="refresh-note">{props.refreshNote}</span>}
      </div>
    </div>
  );
}
