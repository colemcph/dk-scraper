import type { FeedMeta } from '../../shared/types.js';
import { formatAgo, formatMs, formatSeconds, percentile } from '../format.js';
import { serverAgoMs } from '../timeSync.js';
import { BookBadge } from './BookBadge.js';
import { freshnessBoundMs } from './StatusStrip.js';

interface Props {
  dk: FeedMeta | null;
  fd: FeedMeta | null;
  browserLegSamples: number[];
  clockOffsetMs: number | null;
  clockRttMs: number | null;
  browserNow: number;
}

function DraftKingsSection({ meta }: { meta: FeedMeta }) {
  const lat = meta.latency;
  const c = meta.counters;
  return (
    <>
      <div>
        <dt title="DraftKings odds-engine createdTime → our server receipt, corrected for the clock offset estimated from the subscribe round trip">
          DraftKings → server
        </dt>
        <dd>
          {lat.samples > 0 ? (
            <>
              p50 <strong>{formatMs(lat.p50Ms)}</strong> · p95 {formatMs(lat.p95Ms)}{' '}
              <span className="muted">({lat.samples} updates)</span>
            </>
          ) : (
            <span className="muted">waiting for the first push update</span>
          )}
        </dd>
      </div>
      {(lat.byPhase.inplay.samples > 0 || lat.byPhase.pregame.samples > 0) && (
        <div>
          <dt title="Split by whether the game was in play when the price moved. The inside-DraftKings share is their engine-to-socket publish delay, which their own timestamps show varying from tens of milliseconds on quiet days to over a second during busy slates; their website waits for the same publish.">
            By game phase
          </dt>
          <dd className="small">
            {(['pregame', 'inplay'] as const).map((phase) => {
              const p = lat.byPhase[phase];
              if (p.samples === 0) return null;
              return (
                <div key={phase}>
                  {phase === 'inplay' ? 'in-play' : 'pre-game'}: p50{' '}
                  <strong>{formatMs(p.p50Ms)}</strong> · p95 {formatMs(p.p95Ms)}{' '}
                  <span className="muted">
                    (of which inside DraftKings {formatMs(p.pipelineP50Ms)}; {p.samples} updates)
                  </span>
                </div>
              );
            })}
          </dd>
        </div>
      )}
      <div>
        <dt title="createdTime → websocketPublishTimestamp on DraftKings' own clocks (no skew involved), then socket publish → our receipt after skew correction">
          Breakdown
        </dt>
        <dd className="small">
          {lat.samples > 0 ? (
            <>
              inside DraftKings p50 <strong>{formatMs(lat.pipelineP50Ms)}</strong> · network p50{' '}
              <strong>{formatMs(lat.transportP50Ms)}</strong> (min {formatMs(lat.transportMinMs)}) ·{' '}
              <span className={lat.negativeTransportSamples > 0 ? 'warn-text' : ''}>
                self-check: {lat.negativeTransportSamples} negative of {lat.samples}
              </span>
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </dd>
      </div>
      <div>
        <dt title="From the subscribe round trip (ack carries DraftKings' time), then refined continuously from every frame's publish timestamp; uncertainty ≈ RTT/2">
          Server ↔ DraftKings clock skew
        </dt>
        <dd>
          {lat.clockSkewMs != null ? (
            <>
              {lat.clockSkewMs >= 0 ? '+' : ''}
              {lat.clockSkewMs} ms{' '}
              <span className="muted">
                ({lat.skewSource === 'tracked' ? 'tracked from frames' : 'from subscribe ack'}, RTT{' '}
                {lat.skewRttMs} ms)
              </span>
            </>
          ) : (
            '—'
          )}
        </dd>
      </div>
      <div>
        <dt>Feed</dt>
        <dd>
          {meta.feedState}
          {meta.socketConnectedAt && (
            <span className="muted">
              {' '}
              · socket up since {new Date(meta.socketConnectedAt).toLocaleTimeString()}
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt title="socket updates / snapshots / socket reconnects / drift (changes a snapshot found that the socket never delivered, after a 15 s grace period — should stay 0) / snapshot-first (changes a snapshot saw before the socket published them; expected, since DraftKings publishes to the socket seconds after its engine moves) / stale-skips (snapshot fields ignored because the socket was newer)">
          Counters
        </dt>
        <dd className="small">
          {c.socketUpdates} push · {c.restSnapshots} snapshots · {c.socketReconnects} reconnects ·{' '}
          {c.restFailures} REST failures ·{' '}
          <span className={c.driftCorrections > 0 ? 'warn-text' : ''}>
            {c.driftCorrections} drift
          </span>{' '}
          · {c.snapshotLeads} snapshot-first · {c.staleSnapshotSkips} stale-skips ·{' '}
          {c.invalidEntities} invalid
        </dd>
      </div>
      {meta.lastError && (
        <div>
          <dt>Last upstream error</dt>
          <dd className="small warn-text">
            {new Date(meta.lastError.at).toLocaleTimeString()} — {meta.lastError.message}
          </dd>
        </div>
      )}
    </>
  );
}

function FanDuelSection({
  meta,
  offset,
  browserNow,
}: {
  meta: FeedMeta;
  offset: number;
  browserNow: number;
}) {
  const p = meta.poll;
  const c = meta.counters;
  const bound = freshnessBoundMs(meta);
  const generatedAgo = serverAgoMs(p?.generatedAt, offset, browserNow);
  const polledAgo = serverAgoMs(p?.lastPollAt, offset, browserNow);
  return (
    <>
      <div>
        <dt title="FanDuel publishes no timestamps and has no public push feed. Its page API sits behind a CloudFront cache; the copy we receive can be up to max-age old, and we look again within one poll interval of it being able to change. This is the most a FanDuel number on this page can lag FanDuel's own public API.">
          FanDuel freshness bound
        </dt>
        <dd>
          <strong>≤ {formatSeconds(bound)}</strong>{' '}
          <span className="muted">
            {p?.bypassCache
              ? `(cache bypassed: ${formatSeconds(p.intervalMs)} poll + request)`
              : `(CDN max-age ${formatSeconds(p?.cacheMaxAgeMs)} + ${formatSeconds(p?.intervalMs)} poll)`}
          </span>
        </dd>
      </div>
      <div>
        <dt title="Response Date minus Age on the CDN's clock: when the copy we hold was produced by FanDuel's origin. The Age at receipt says how long it had already sat at the edge.">
          Copy we hold
        </dt>
        <dd className="small">
          {p?.generatedAt ? (
            <>
              generated <strong>{formatAgo(generatedAgo ?? 0)}</strong>
              {p.lastAgeMs !== null && <> · age at receipt {formatSeconds(p.lastAgeMs)}</>}
              {p.lastCacheHit !== null && <> · {p.lastCacheHit ? 'edge hit' : 'edge miss'}</>}
            </>
          ) : (
            <span className="muted">no response yet</span>
          )}
        </dd>
      </div>
      <div>
        <dt title="The adapter sleeps until the edge copy can change (max-age − age), then polls at the base interval with If-None-Match until it does. Unchanged polls are 304s of a few hundred bytes.">
          Polling
        </dt>
        <dd className="small">
          {p ? (
            <>
              base {formatSeconds(p.intervalMs)} · next in {formatSeconds(p.suggestedIntervalMs)} ·
              last {polledAgo === null ? '—' : formatAgo(polledAgo)} →{' '}
              <strong>{p.lastStatus ?? '—'}</strong>
              {p.lastStatus === 304 && <span className="muted"> not modified</span>} in{' '}
              {formatMs(p.lastMs)} · p50 {formatMs(p.p50Ms)}
              {p.etag && <span className="muted"> · ETag {p.etag.slice(0, 14)}…</span>}
            </>
          ) : (
            '—'
          )}
        </dd>
      </div>
      <div>
        <dt>Feed</dt>
        <dd>{meta.feedState}</dd>
      </div>
      <div>
        <dt title="page bodies received (200) / polls answered 304 Not Modified / failed requests / entities that could not be mapped">
          Counters
        </dt>
        <dd className="small">
          {c.restSnapshots} bodies · {c.restNotModified} not-modified · {c.restFailures} failures ·{' '}
          {c.invalidEntities} invalid
        </dd>
      </div>
      {meta.lastError && (
        <div>
          <dt>Last upstream error</dt>
          <dd className="small warn-text">
            {new Date(meta.lastError.at).toLocaleTimeString()} — {meta.lastError.message}
          </dd>
        </div>
      )}
    </>
  );
}

export function LatencyPanel({
  dk,
  fd,
  browserLegSamples,
  clockOffsetMs,
  clockRttMs,
  browserNow,
}: Props) {
  const legP50 = percentile(browserLegSamples, 0.5);
  const legP95 = percentile(browserLegSamples, 0.95);
  const offset = clockOffsetMs ?? 0;

  return (
    <section className="panel">
      <h2>Latency &amp; feed health</h2>
      <dl className="stats">
        {dk && (
          <>
            <div className="stats-book">
              <BookBadge book="draftkings" full />
            </div>
            <DraftKingsSection meta={dk} />
          </>
        )}
        {fd && (
          <>
            <div className="stats-book">
              <BookBadge book="fanduel" full />
            </div>
            <FanDuelSection meta={fd} offset={offset} browserNow={browserNow} />
          </>
        )}
        <div className="stats-book">
          <span className="book-badge book-badge--neutral">this page</span>
        </div>
        <div>
          <dt title="SSE emit time on the server → receipt in this tab, corrected for this browser's clock offset">
            Server → this browser
          </dt>
          <dd>
            {legP50 !== null ? (
              <>
                p50 <strong>{formatMs(legP50)}</strong> · p95 {formatMs(legP95)}
              </>
            ) : (
              <span className="muted">no updates received yet</span>
            )}
          </dd>
        </div>
        <div>
          <dt title="Estimated from /api/time round trips">Browser ↔ server clock skew</dt>
          <dd>
            {clockOffsetMs != null ? (
              <>
                {clockOffsetMs >= 0 ? '+' : ''}
                {Math.round(clockOffsetMs)} ms <span className="muted">(RTT {clockRttMs} ms)</span>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>
      <p className="muted small">
        DraftKings stamps every push with its odds-engine <code>createdTime</code>; that number is
        the stamp to this screen, not a poll interval. FanDuel offers no push feed and no
        timestamps, so its figure is a bound: the CDN's max-age plus one poll interval, with
        ETag-validated polls so an unchanged page costs almost nothing. If DraftKings' socket is
        down the page polls its snapshots every 3 s and says so.
      </p>
    </section>
  );
}
