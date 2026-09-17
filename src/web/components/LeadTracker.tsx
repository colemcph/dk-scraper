import { useMemo } from 'react';
import { pairKeyOf, pairMoves, type BookMove } from '../../shared/compare.js';
import { BOOK_IDS, BOOK_LABEL, type BookId } from '../../shared/types.js';
import type { BookState, RecentMove } from '../useOddsFeed.js';
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
  books: Partial<Record<BookId, BookState>>;
  format: OddsFormat;
  /** Two moves closer than this are treated as one move seen at two books. */
  windowMs?: number;
  limit?: number;
}

function describe(m: BookMove, format: OddsFormat): string {
  const after = `${m.nextLine !== undefined ? formatLine(m.market, m.side, m.nextLine) + ' ' : ''}${formatOdds(m.nextOdds, format)}`;
  return after;
}

/**
 * "Who moved first?" — pairs each price change with the same change at the other book and counts
 * which book showed it first. Works off the browser's own move history, so it needs both feeds to
 * have moved the same market while this tab was open.
 */
export function LeadTracker({ moves, books, format, windowMs = 120_000, limit = 8 }: Props) {
  const pairing = useMemo(
    () =>
      pairMoves(
        moves,
        (m) => {
          const game = books[m.book]?.games[m.gameId];
          return game ? pairKeyOf(game).key : undefined;
        },
        windowMs,
      ),
    [moves, books, windowMs],
  );
  const total = pairing.paired.length;
  const recent = [...pairing.paired].reverse().slice(0, limit);

  return (
    <section className="panel">
      <h2>
        Who moved first? <span className="muted">{total} paired</span>
      </h2>
      {total === 0 ? (
        <p className="muted small">
          No move has shown up at both books yet while this tab has been open. When one line moves
          at DraftKings and FanDuel within {Math.round(windowMs / 1000)} s, it lands here with the
          lead time.
        </p>
      ) : (
        <>
          <dl className="stats lead-summary">
            {BOOK_IDS.filter((b) => books[b]).map((book) => (
              <div key={book}>
                <dt>{BOOK_LABEL[book]} first</dt>
                <dd>
                  <strong>{pairing.leads[book]}</strong> of {total}
                  {pairing.medianLeadMs[book] !== null && (
                    <span className="muted">
                      {' '}
                      · median lead {formatMs(pairing.medianLeadMs[book])}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <ul className="moves lead-list">
            {recent.map((p) => {
              const game = books[p.first.book]?.games[p.first.gameId];
              const label = game ? `${game.away.shortName} @ ${game.home.shortName}` : p.key;
              return (
                <li key={`${p.key}-${p.first.at}-${p.second.at}`} className="move">
                  <div className="move-head">
                    <span className="move-time">{formatClock(p.first.at)}</span>
                    <span className="move-game">{label}</span>
                    <span className="move-market">
                      {MARKET_LABEL[p.market]} · {p.side} → {describe(p.second, format)}
                    </span>
                  </div>
                  <div className="move-body lead-body">
                    <BookBadge book={p.first.book} /> first
                    <span className="move-arrow move-arrow--flat">→</span>
                    <BookBadge book={p.second.book} /> <strong>+{formatMs(p.leadMs)}</strong>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="muted small">
        FanDuel's time is when this service saw the change behind FanDuel's CDN cache (up to 30 s
        after their trader moved), DraftKings' is their engine timestamp. A FanDuel "lead" means the
        number was public on FanDuel first; a DraftKings lead of under ~30 s says nothing about who
        priced it first.
      </p>
    </section>
  );
}
