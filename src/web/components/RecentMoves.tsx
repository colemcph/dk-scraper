import type { RecentMove } from '../hooks/useOddsFeed.js';
import {
  formatClock,
  formatLine,
  formatMs,
  formatOdds,
  MARKET_LABEL,
  type OddsFormat,
} from '../lib/format.js';

interface Props {
  moves: RecentMove[];
  format: OddsFormat;
}

function endToEnd(move: RecentMove): number | null {
  if (!move.latency) return null;
  const serverHold = 0; // emitted synchronously after apply; not measured separately
  return move.latency.dkToServerMs + serverHold + (move.serverToBrowserMs ?? 0);
}

export function RecentMoves({ moves, format }: Props) {
  return (
    <section className="panel">
      <h2>
        Recent moves <span className="muted">last {moves.length}</span>
      </h2>
      {moves.length === 0 ? (
        <p className="muted small">
          No line movement since this page connected. Moves appear here the moment DraftKings pushes
          them.
        </p>
      ) : (
        <ul className="moves">
          {moves.map((m, i) => {
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
                key={`${m.gameId}-${m.market}-${m.side}-${m.at}-${i}`}
                className={`move move--${m.field}`}
              >
                <div className="move-head">
                  <span className="move-time">{formatClock(m.at)}</span>
                  <span className="move-game">{m.gameLabel}</span>
                  <span className="move-market">
                    {MARKET_LABEL[m.market]} · {m.sideLabel}
                  </span>
                </div>
                <div className="move-body">
                  <span className="move-before">{before}</span>
                  <span className={`move-arrow move-arrow--${dir || 'flat'}`}>→</span>
                  <span className="move-after">{after}</span>
                  <span className="move-source muted">
                    {m.source === 'socket' ? 'push' : 'snapshot'}
                  </span>
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
