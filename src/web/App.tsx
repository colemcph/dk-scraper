import { useCallback, useEffect, useMemo, useState } from 'react';
import { LatencyPanel } from './components/LatencyPanel.js';
import { OddsTable } from './components/OddsTable.js';
import { RecentMoves } from './components/RecentMoves.js';
import { displayState, StatusStrip } from './components/StatusStrip.js';
import { useOddsFeed } from './hooks/useOddsFeed.js';
import { localTimeZoneLabel, percentile, type OddsFormat } from './lib/format.js';

const FORMAT_KEY = 'odds-format';

function loadFormat(): OddsFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === 'american' ? 'american' : 'decimal';
  } catch {
    return 'decimal';
  }
}

export function App() {
  const { state, refresh } = useOddsFeed();
  const [format, setFormat] = useState<OddsFormat>(loadFormat);
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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const r = await refresh();
    setRefreshing(false);
    setRefreshNote(r.message);
    setTimeout(() => setRefreshNote(null), 4000);
  }, [refresh]);

  const games = useMemo(
    () =>
      Object.values(state.games).sort(
        (a, b) =>
          a.startTime.localeCompare(b.startTime) ||
          a.away.shortName.localeCompare(b.away.shortName),
      ),
    [state.games],
  );
  const serverNow = browserNow - (state.clockOffsetMs ?? 0);
  const view = displayState(state.meta, state.connection);
  const browserLegP50 = percentile(state.browserLegSamples, 0.5);
  const showBanner = view.tone === 'bad' || (view.tone === 'warn' && state.connection !== 'open');

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>
            {state.meta?.leagueName ?? 'NFL'} odds <span className="muted">·</span> DraftKings
            Ontario
          </h1>
          <p className="subtitle">
            Moneyline, spread and total for every upcoming game, pushed live from DraftKings' own
            feed.
            {state.meta && (
              <span className="muted">
                {' '}
                · site {state.meta.site} · league {state.meta.leagueName} ({state.meta.league})
              </span>
            )}
          </p>
        </div>
      </header>

      <StatusStrip
        meta={state.meta}
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

      {showBanner && (
        <div className={`banner banner--${view.tone}`} role="status">
          <strong>{view.label}</strong> — {view.detail}.{' '}
          {state.meta?.lastSnapshotAt && (
            <>
              Odds below were last confirmed at{' '}
              {new Date(state.meta.lastSnapshotAt).toLocaleTimeString()}.
            </>
          )}
          {state.meta?.lastError && (
            <span className="muted"> Last error: {state.meta.lastError.message}</span>
          )}
        </div>
      )}

      <main className="layout">
        <div className="layout-main">
          {games.length === 0 ? (
            <div className="empty">
              {state.meta?.feedState === 'degraded' || state.meta?.feedState === 'bootstrapping' ? (
                <>
                  <h2>Waiting for DraftKings…</h2>
                  <p className="muted">
                    The server has not been able to load a snapshot yet and is retrying with
                    backoff.
                    {state.meta?.lastError && <> Last error: {state.meta.lastError.message}</>}
                  </p>
                </>
              ) : state.connection !== 'open' && !state.meta ? (
                <>
                  <h2>Connecting…</h2>
                </>
              ) : (
                <>
                  <h2>No upcoming {state.meta?.leagueName ?? 'NFL'} games listed</h2>
                  <p className="muted">
                    DraftKings currently has no main-line markets open for this league.
                  </p>
                </>
              )}
            </div>
          ) : (
            <OddsTable
              games={games}
              format={format}
              flashes={state.flashes}
              serverNow={serverNow}
              tzLabel={tzLabel}
            />
          )}
        </div>
        <aside className="layout-side">
          <RecentMoves moves={state.moves} format={format} />
          <LatencyPanel
            meta={state.meta}
            browserLegSamples={state.browserLegSamples}
            clockOffsetMs={state.clockOffsetMs}
            clockRttMs={state.clockRttMs}
          />
        </aside>
      </main>

      <footer className="app-footer muted small">
        Data: DraftKings Sportsbook (Ontario). Unofficial, read-only mirror built for a Betstamp
        take-home; not affiliated with DraftKings. Times shown in your local timezone ({tzLabel}).
      </footer>
    </div>
  );
}
