import { useCallback, useEffect, useMemo, useState } from 'react';
import { matchGames } from '../shared/compare.js';
import { BOOK_IDS, BOOK_LABEL, type BookId, type FeedMeta, type Game } from '../shared/types.js';
import { CompareTable } from './components/CompareTable.js';
import { LatencyPanel } from './components/LatencyPanel.js';
import { LeadTracker } from './components/LeadTracker.js';
import { OddsTable } from './components/OddsTable.js';
import { RecentMoves } from './components/RecentMoves.js';
import { displayState, StatusStrip } from './components/StatusStrip.js';
import { useOddsFeed, type Connection } from './useOddsFeed.js';
import { localTimeZoneLabel, percentile, type OddsFormat } from './format.js';

type View = 'compare' | BookId;

const FORMAT_KEY = 'odds-format';
const VIEW_KEY = 'odds-view';

function loadFormat(): OddsFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === 'american' ? 'american' : 'decimal';
  } catch {
    return 'decimal';
  }
}

function loadView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'draftkings' || v === 'fanduel' || v === 'compare' ? v : 'compare';
  } catch {
    return 'compare';
  }
}

function sortGames(games: Record<string, Game>): Game[] {
  return Object.values(games).sort(
    (a, b) =>
      a.startTime.localeCompare(b.startTime) || a.away.shortName.localeCompare(b.away.shortName),
  );
}

function EmptyState({
  meta,
  connection,
  leagueName,
  bookName,
}: {
  meta: FeedMeta | null;
  connection: Connection;
  leagueName: string;
  bookName: string;
}) {
  return (
    <div className="empty">
      {meta?.feedState === 'degraded' || meta?.feedState === 'bootstrapping' ? (
        <>
          <h2>Waiting for {bookName}…</h2>
          <p className="muted">
            The server has not been able to load a snapshot yet and is retrying with backoff.
            {meta?.lastError && <> Last error: {meta.lastError.message}</>}
          </p>
        </>
      ) : connection !== 'open' && !meta ? (
        <h2>Connecting…</h2>
      ) : (
        <>
          <h2>No upcoming {leagueName} games listed</h2>
          <p className="muted">
            {bookName} currently has no main-line markets open for this league.
          </p>
        </>
      )}
    </div>
  );
}

export function App() {
  const { state, refresh } = useOddsFeed();
  const [format, setFormat] = useState<OddsFormat>(loadFormat);
  const [view, setView] = useState<View>(loadView);
  const [browserNow, setBrowserNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const tzLabel = useMemo(localTimeZoneLabel, []);

  useEffect(() => {
    const t = setInterval(() => setBrowserNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const onFormat = useCallback((f: OddsFormat) => {
    setFormat(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* private mode */
    }
  }, []);

  const onView = useCallback((v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const r = await refresh();
    setRefreshing(false);
    setRefreshNote(r.message);
    setTimeout(() => setRefreshNote(null), 4000);
  }, [refresh]);

  // Books in a fixed order (DraftKings, FanDuel), only those the server streams.
  const books = useMemo(() => BOOK_IDS.filter((b) => state.books[b] !== undefined), [state.books]);
  const gamesByBook = useMemo(() => {
    const out: Partial<Record<BookId, Game[]>> = {};
    for (const b of books) out[b] = sortGames(state.books[b]!.games);
    return out;
  }, [books, state.books]);
  const pairs = useMemo(
    () => matchGames(books.flatMap((b) => gamesByBook[b] ?? [])),
    [books, gamesByBook],
  );

  // Compare needs two books; a stored view for a book the server no longer streams falls back.
  const activeView: View =
    view === 'compare'
      ? books.length === 1
        ? books[0]!
        : 'compare'
      : books.includes(view)
        ? view
        : books.length >= 2
          ? 'compare'
          : (books[0] ?? 'compare');

  const serverNow = browserNow - (state.clockOffsetMs ?? 0);
  const browserLegP50 = percentile(state.browserLegSamples, 0.5);
  const dkMeta = state.books.draftkings?.meta ?? null;
  const fdMeta = state.books.fanduel?.meta ?? null;
  const leagueName = dkMeta?.leagueName ?? fdMeta?.leagueName ?? 'NFL';

  const banners =
    state.connection !== 'open'
      ? [{ key: 'conn', ...displayState(null, state.connection), meta: null as FeedMeta | null }]
      : books
          .map((b) => ({
            key: b,
            meta: state.books[b]!.meta,
            ...displayState(state.books[b]!.meta, state.connection),
          }))
          .filter((b) => b.tone === 'bad');

  const activeMeta = activeView === 'compare' ? dkMeta : (state.books[activeView]?.meta ?? null);
  const activeGames = activeView === 'compare' ? [] : (gamesByBook[activeView] ?? []);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>
            {leagueName} odds <span className="muted">·</span>{' '}
            {books.length > 0
              ? books.map((b) => BOOK_LABEL[b]).join(' vs ')
              : 'DraftKings vs FanDuel'}{' '}
            <span className="muted">·</span> Ontario
          </h1>
          <p className="subtitle">
            Moneyline, spread and total for every upcoming game: pushed live from DraftKings' own
            feed, polled from FanDuel's page API as fast as its CDN cache allows, and matched game
            by game.
            {dkMeta && (
              <span className="muted">
                {' '}
                · DK site {dkMeta.site} · league {dkMeta.leagueName} ({dkMeta.league})
              </span>
            )}
            {fdMeta && (
              <span className="muted">
                {' '}
                · FD region {fdMeta.site} · page {fdMeta.league}
              </span>
            )}
          </p>
        </div>
      </header>

      <StatusStrip
        books={books.map((b) => ({ book: b, meta: state.books[b]!.meta }))}
        connection={state.connection}
        clockOffsetMs={state.clockOffsetMs}
        browserNow={browserNow}
        browserLegP50={browserLegP50}
        refreshing={refreshing}
        refreshNote={refreshNote}
        onRefresh={onRefresh}
        format={format}
        onFormat={onFormat}
      />

      {banners.map((b) => (
        <div key={b.key} className={`banner banner--${b.tone}`} role="status">
          <strong>{b.label}</strong> — {b.detail}.{' '}
          {b.meta?.lastSnapshotAt && (
            <>
              {b.meta.bookName} odds below were last confirmed at{' '}
              {new Date(b.meta.lastSnapshotAt).toLocaleTimeString()}.
            </>
          )}
          {b.meta?.lastError && (
            <span className="muted"> Last error: {b.meta.lastError.message}</span>
          )}
        </div>
      ))}

      {books.length >= 2 && (
        <nav className="tabs" aria-label="View">
          <button
            className={activeView === 'compare' ? 'active' : ''}
            onClick={() => onView('compare')}
          >
            Compare <span className="muted">{pairs.length}</span>
          </button>
          {books.map((b) => (
            <button key={b} className={activeView === b ? 'active' : ''} onClick={() => onView(b)}>
              {BOOK_LABEL[b]} <span className="muted">{gamesByBook[b]?.length ?? 0}</span>
            </button>
          ))}
        </nav>
      )}

      <main className="layout">
        <div className="layout-main">
          {activeView === 'compare' ? (
            pairs.length === 0 ? (
              <EmptyState
                meta={activeMeta}
                connection={state.connection}
                leagueName={leagueName}
                bookName="DraftKings"
              />
            ) : (
              <CompareTable
                pairs={pairs}
                books={books}
                format={format}
                flashes={state.flashes}
                serverNow={serverNow}
                tzLabel={tzLabel}
              />
            )
          ) : activeGames.length === 0 ? (
            <EmptyState
              meta={activeMeta}
              connection={state.connection}
              leagueName={leagueName}
              bookName={BOOK_LABEL[activeView]}
            />
          ) : (
            <OddsTable
              book={activeView}
              games={activeGames}
              format={format}
              flashes={state.flashes}
              serverNow={serverNow}
              tzLabel={tzLabel}
            />
          )}
        </div>
        <aside className="layout-side">
          <RecentMoves moves={state.moves} format={format} />
          {books.length >= 2 && (
            <LeadTracker moves={state.moves} books={state.books} format={format} />
          )}
          <LatencyPanel
            dk={dkMeta}
            fd={fdMeta}
            browserLegSamples={state.browserLegSamples}
            clockOffsetMs={state.clockOffsetMs}
            clockRttMs={state.clockRttMs}
            browserNow={browserNow}
          />
        </aside>
      </main>

      <footer className="app-footer muted small">
        Data: DraftKings Sportsbook (Ontario) and FanDuel Sportsbook (Ontario). Unofficial,
        read-only mirror built for a Betstamp take-home; not affiliated with either book. Times
        shown in your local timezone ({tzLabel}).
      </footer>
    </div>
  );
}
