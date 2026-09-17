import { Fragment, useMemo } from 'react';
import {
  compareMarket,
  impliedProbability,
  type GamePair,
  type PriceAtBook,
  type SideComparison,
} from '../../shared/compare.js';
import { BOOK_LABEL, type BookId, type MarketType, type SideKey } from '../../shared/types.js';
import { cellKey, FLASH_MS, type Flash } from '../useOddsFeed.js';
import {
  dayKey,
  formatDayHeading,
  formatKickoff,
  formatLine,
  formatOdds,
  formatPct,
  type OddsFormat,
} from '../format.js';
import { BookBadge } from './BookBadge.js';

interface Props {
  pairs: GamePair[];
  /** Column order for the per-book rows inside each cell. */
  books: BookId[];
  format: OddsFormat;
  flashes: Record<string, Flash>;
  serverNow: number;
  tzLabel: string;
}

const ROWS: Array<{ team: 'away' | 'home'; ml: SideKey; spread: SideKey; total: SideKey }> = [
  { team: 'away', ml: 'away', spread: 'away', total: 'over' },
  { team: 'home', ml: 'home', spread: 'home', total: 'under' },
];

const MARKETS: MarketType[] = ['moneyline', 'spread', 'total'];

function priceTitle(
  book: BookId,
  market: MarketType,
  side: SideComparison,
  price: PriceAtBook,
  hold: number | undefined,
  format: OddsFormat,
): string {
  const line = formatLine(market, side.side, price.line);
  return [
    `${BOOK_LABEL[book]}: ${side.label}${line ? ` ${line}` : ''} ${formatOdds(price.odds, format)}`,
    `Implied ${formatPct(impliedProbability(price.odds.decimal))}${hold !== undefined ? ` · ${BOOK_LABEL[book]} hold on this market ${formatPct(hold)}` : ''}`,
    price.suspended ? `SUSPENDED by ${BOOK_LABEL[book]}` : '',
    side.best === book && side.edge
      ? `Best price for this side (+${side.edge.toFixed(3)} decimal over the next book)`
      : '',
    !side.sameLine ? 'Books quote different lines here, so prices are not directly comparable' : '',
    `Updated ${new Date(price.updatedAt).toLocaleTimeString()}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** One market cell: a stacked row per book, best price highlighted when the lines agree. */
function CompareCell({
  pair,
  market,
  sideKey,
  books,
  format,
  flashes,
}: {
  pair: GamePair;
  market: MarketType;
  sideKey: SideKey;
  books: BookId[];
  format: OddsFormat;
  flashes: Record<string, Flash>;
}) {
  const cmp = compareMarket(pair, market);
  const side = cmp.sides.find((s) => s.side === sideKey);
  if (!side) return <td className="cmp-cell" />;
  return (
    <td className={`cmp-cell${side.sameLine ? '' : ' cmp-cell--lines-differ'}`}>
      {books.map((book) => {
        const price = side.at[book];
        const game = pair.games[book];
        if (!price || !game) {
          const why = !game
            ? `${BOOK_LABEL[book]} does not list this game`
            : `${BOOK_LABEL[book]} is not offering this market`;
          return (
            <div key={book} className="cmp-price cmp-price--empty" title={why}>
              <BookBadge book={book} />
              <span className="odds-dash">—</span>
            </div>
          );
        }
        const flash = flashes[cellKey(book, game.id, market, sideKey)];
        const active = flash && Date.now() - flash.at < FLASH_MS ? flash.kind : undefined;
        const line = formatLine(market, sideKey, price.line);
        const cls = [
          'cmp-price',
          side.best === book ? 'cmp-price--best' : '',
          price.suspended ? 'cmp-price--suspended' : '',
          active ? `flash flash--${active}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            key={book}
            className={cls}
            title={priceTitle(book, market, side, price, cmp.hold[book], format)}
          >
            <BookBadge book={book} />
            <span key={price.updatedAt} className="odds-main">
              {line && <span className="odds-line">{line}</span>}
              <span className="odds-price">{formatOdds(price.odds, format)}</span>
            </span>
          </div>
        );
      })}
    </td>
  );
}

/** Every matched game with each book's price side by side; the better price is marked. */
export function CompareTable({ pairs, books, format, flashes, serverNow, tzLabel }: Props) {
  const groups = useMemo(() => {
    const byDay = new Map<string, GamePair[]>();
    for (const p of pairs) {
      const key = dayKey(p.startTime);
      const list = byDay.get(key);
      if (list) list.push(p);
      else byDay.set(key, [p]);
    }
    return [...byDay.entries()];
  }, [pairs]);

  if (pairs.length === 0) return null;
  void serverNow;

  return (
    <div className="table-wrap">
      <table className="odds-table cmp-table">
        <thead>
          <tr>
            <th className="col-time">Kickoff ({tzLabel})</th>
            <th className="col-team">Game</th>
            <th>Moneyline</th>
            <th>Spread</th>
            <th>Total</th>
          </tr>
        </thead>
        {groups.map(([key, dayPairs]) => (
          <Fragment key={key}>
            <tbody className="day-heading">
              <tr>
                <th colSpan={5}>
                  {formatDayHeading(dayPairs[0]!.startTime)}
                  <span className="day-count">
                    {dayPairs.length} game{dayPairs.length === 1 ? '' : 's'}
                  </span>
                </th>
              </tr>
            </tbody>
            {dayPairs.map((pair) => {
              const listedBy = books.filter((b) => pair.games[b]);
              const live = Object.values(pair.games).find((g) => g.status === 'live');
              return (
                <tbody
                  key={pair.key + pair.startTime}
                  className={`game${pair.status === 'live' ? ' game--live' : ''}`}
                >
                  {ROWS.map((row, i) => {
                    const team = pair[row.team];
                    const score = live?.live?.[row.team === 'away' ? 'awayScore' : 'homeScore'];
                    return (
                      <tr key={row.team}>
                        {i === 0 && (
                          <td className="col-time" rowSpan={2}>
                            {pair.status === 'live' ? (
                              <span className="live-pill">
                                <span className="live-dot" /> LIVE
                                {live?.live?.period ? ` · ${live.live.period}` : ''}
                                {live?.live?.clock ? ` · ${live.live.clock}` : ''}
                              </span>
                            ) : (
                              formatKickoff(pair.startTime)
                            )}
                            {listedBy.length < books.length && (
                              <span
                                className="cmp-only muted"
                                title={`Only ${listedBy.map((b) => BOOK_LABEL[b]).join(', ')} lists this game right now`}
                              >
                                {listedBy.map((b) => BOOK_LABEL[b]).join(', ')} only
                              </span>
                            )}
                          </td>
                        )}
                        <td className="col-team">
                          <span
                            className="team-swatch"
                            style={{ background: team.color ?? '#555' }}
                          />
                          <span className="team-name">{team.name}</span>
                          {typeof score === 'number' && <span className="team-score">{score}</span>}
                        </td>
                        {MARKETS.map((market) => (
                          <CompareCell
                            key={market}
                            pair={pair}
                            market={market}
                            sideKey={row[market === 'moneyline' ? 'ml' : market]}
                            books={books}
                            format={format}
                            flashes={flashes}
                          />
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </Fragment>
        ))}
      </table>
    </div>
  );
}
