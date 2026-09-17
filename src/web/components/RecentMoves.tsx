import type { RecentMove } from '../useOddsFeed.js';
import {
  formatClock,
  formatLine,
  formatMs,
  formatOdds,
  MARKET_LABEL,
  type OddsFormat,
} from '../format.js';
import { BookBadge } from './BookBadge.js';

interface Props {
  moves: RecentMove[];
  format: OddsFormat;
  /** The state keeps a longer history for the lead tracker; the list shows this many. */
  limit?: number;
}

/** DraftKings createdTime -> this browser. The server emits synchronously after applying, so there is no separate server-hold term. */
function endToEnd(move: RecentMove): number | null {
  if (!move.latency) return null;
  return move.latency.dkToServerMs + (move.serverToBrowserMs ?? 0);
}

function sourceLabel(move: RecentMove): string {
  if (move.source === 'socket') return 'push';
  return move.book === 'fanduel' ? 'poll' : 'snapshot';
}

export function RecentMoves({ moves, format, limit = 40 }: Props) {
  const shown = moves.slice(0, limit);
  return (
    <section className="panel">
      <h2>
        Recent moves <span className="muted">last {shown.length}</span>
      </h2>
      {shown.length === 0 ? (
        <p className="muted small">
          No line movement since this page connected. DraftKings moves appear the moment they are
          pushed; FanDuel moves as soon as a poll sees them.
        </p>
      ) : (
        <ul className="moves">
          {shown.map((m, i) => {
            const before = m.prevOdds
              ? `${m.field === 'line' && m.prevLine !== undefined ? formatLine(m.market, m.side, m.prevLine) + ' ' : ''}${formatOdds(m.prevOdds, format)}`
              : '—';
            const after = `${m.nextLine !== undefined ? formatLine(m.market, m.side, m.nextLine) + ' ' : ''}${formatOdds(m.nextOdds, format)}`;
            const dir = m.prevOdds
              ? m.nextOdds.decimal > m.prevOdds.decimal
                ? 'up'
                : m.nextOdds.decimal < m.prevOdds.decimal
                  ? 'down'
                  : ''
              : '';
            const e2e = endToEnd(m);
            return (
              <li
                key={`${m.book}-${m.gameId}-${m.market}-${m.side}-${m.at}-${i}`}
                className={`move move--${m.field}`}
              >
                <div className="move-head">
                  <span className="move-time">{formatClock(m.at)}</span>
                  <BookBadge book={m.book} />
                  <span className="move-game">{m.gameLabel}</span>
                  <span className="move-market">
                    {MARKET_LABEL[m.market]} · {m.sideLabel}
                  </span>
                </div>
                <div className="move-body">
                  <span className="move-before">{before}</span>
                  <span className={`move-arrow move-arrow--${dir || 'flat'}`}>→</span>
                  <span className="move-after">{after}</span>
                  <span className="move-source muted">{sourceLabel(m)}</span>
                </div>
                {m.latency && (
                  <div
                    className="move-latency muted"
                    title="DraftKings createdTime → our server (skew-corrected) → this browser"
                  >
                    DK→server {formatMs(m.latency.dkToServerMs)}
                    {m.serverToBrowserMs !== null && (
                      <> · server→you {formatMs(m.serverToBrowserMs)}</>
                    )}
                    {e2e !== null && (
                      <>
                        {' '}
                        · <strong>total {formatMs(e2e)}</strong>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
