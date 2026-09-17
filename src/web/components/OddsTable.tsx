import { Fragment, useMemo } from 'react';
import {
  BOOK_LABEL,
  type BookId,
  type Game,
  type MarketType,
  type SideKey,
} from '../../shared/types.js';
import { cellKey, type Flash } from '../useOddsFeed.js';
import { dayKey, formatDayHeading, formatKickoff, type OddsFormat } from '../format.js';
import { OddsCell } from './OddsCell.js';

interface Props {
  book: BookId;
  games: Game[];
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

/** One book's board: every game, two rows (away/home), the three main markets. */
export function OddsTable({ book, games, format, flashes, serverNow, tzLabel }: Props) {
  const groups = useMemo(() => {
    const byDay = new Map<string, Game[]>();
    for (const g of games) {
      const key = dayKey(g.startTime);
      const list = byDay.get(key);
      if (list) list.push(g);
      else byDay.set(key, [g]);
    }
    return [...byDay.entries()];
  }, [games]);

  if (games.length === 0) return null;
  const bookName = BOOK_LABEL[book];

  return (
    <div className="table-wrap">
      <table className="odds-table">
        <thead>
          <tr>
            <th className="col-time">Kickoff ({tzLabel})</th>
            <th className="col-team">Game</th>
            <th>Moneyline</th>
            <th>Spread</th>
            <th>Total</th>
          </tr>
        </thead>
        {groups.map(([key, dayGames]) => (
          <Fragment key={key}>
            <tbody className="day-heading">
              <tr>
                <th colSpan={5}>
                  {formatDayHeading(dayGames[0]!.startTime)}
                  <span className="day-count">
                    {dayGames.length} game{dayGames.length === 1 ? '' : 's'}
                  </span>
                </th>
              </tr>
            </tbody>
            {dayGames.map((game) => (
              <tbody key={game.id} className={`game${game.status === 'live' ? ' game--live' : ''}`}>
                {ROWS.map((row, i) => {
                  const team = game[row.team];
                  const score = game.live?.[row.team === 'away' ? 'awayScore' : 'homeScore'];
                  return (
                    <tr key={row.team}>
                      {i === 0 && (
                        <td className="col-time" rowSpan={2}>
                          {game.status === 'live' ? (
                            <span className="live-pill">
                              <span className="live-dot" /> LIVE
                              {game.live?.period ? ` · ${game.live.period}` : ''}
                              {game.live?.clock ? ` · ${game.live.clock}` : ''}
                            </span>
                          ) : (
                            formatKickoff(game.startTime)
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
                      {MARKETS.map((market) => {
                        const m = game.markets[market];
                        const sideKey = row[market === 'moneyline' ? 'ml' : market];
                        return (
                          <OddsCell
                            key={market}
                            market={market}
                            side={m?.sides[sideKey]}
                            suspended={m?.suspended ?? false}
                            offered={m !== null && m !== undefined}
                            bookName={bookName}
                            format={format}
                            flash={flashes[cellKey(book, game.id, market, sideKey)]}
                            serverNow={serverNow}
                          />
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </Fragment>
        ))}
      </table>
    </div>
  );
}
