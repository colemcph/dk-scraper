import type { MarketType, Side } from '../../shared/types.js';
import { FLASH_MS, type Flash } from '../hooks/useOddsFeed.js';
import { formatLine, formatOdds, type OddsFormat } from '../lib/format.js';

/** How long the previous price stays visible next to the new one. */
const PREV_VISIBLE_MS = 60_000;

interface Props {
  market: MarketType;
  side: Side | undefined;
  suspended: boolean;
  /** false when DraftKings is not offering this market at all */
  offered: boolean;
  format: OddsFormat;
  flash: Flash | undefined;
  /** browser "now" translated to the server clock */
  serverNow: number;
}

export function OddsCell({ market, side, suspended, offered, format, flash, serverNow }: Props) {
  if (!side) {
    const why = !offered
      ? 'DraftKings is not offering this market'
      : suspended
        ? 'Suspended by DraftKings'
        : 'Side not currently priced';
    return (
      <td className="odds-cell odds-cell--empty" title={why}>
        <span className="odds-dash">—</span>
      </td>
    );
  }

  const active = flash && Date.now() - flash.at < FLASH_MS ? flash.kind : undefined;
  const prev = side.prev;
  const showPrev = prev && serverNow - Date.parse(prev.changedAt) < PREV_VISIBLE_MS;
  const line = formatLine(market, side.key, side.line);
  const lineMoved = showPrev && prev.line !== undefined && prev.line !== side.line;
  const priceDir = showPrev
    ? side.odds.decimal > prev.odds.decimal
      ? 'up'
      : side.odds.decimal < prev.odds.decimal
        ? 'down'
        : ''
    : '';

  const title = [
    `${side.label}${line ? ` ${line}` : ''} ${formatOdds(side.odds, format)}`,
    suspended ? 'SUSPENDED by DraftKings — showing the last price offered' : '',
    `Updated ${new Date(side.updatedAt).toLocaleTimeString()}`,
    prev
      ? `Previously ${prev.line !== undefined ? formatLine(market, side.key, prev.line) + ' ' : ''}${formatOdds(prev.odds, format)} (until ${new Date(prev.changedAt).toLocaleTimeString()})`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <td
      className={`odds-cell${suspended ? ' odds-cell--suspended' : ''}${active ? ` flash flash--${active}` : ''}`}
      title={title}
    >
      {/* Keying on updatedAt remounts the span on every change so the CSS animation restarts. */}
      <span key={side.updatedAt} className="odds-main">
        {line && <span className="odds-line">{line}</span>}
        <span className={`odds-price${priceDir ? ` odds-price--${priceDir}` : ''}`}>
          {formatOdds(side.odds, format)}
        </span>
      </span>
      {showPrev && (
        <span className="odds-prev" aria-label="previous price">
          {priceDir === 'up' ? '▲' : priceDir === 'down' ? '▼' : lineMoved ? '↔' : ''}{' '}
          {lineMoved ? `${formatLine(market, side.key, prev.line)} ` : ''}
          {formatOdds(prev.odds, format)}
        </span>
      )}
    </td>
  );
}
