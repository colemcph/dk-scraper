import type { FeedMeta } from '../../shared/types.js';
import { formatMs, percentile } from '../format.js';

interface Props {
  meta: FeedMeta | null;
  browserLegSamples: number[];
  clockOffsetMs: number | null;
  clockRttMs: number | null;
}

export function LatencyPanel({ meta, browserLegSamples, clockOffsetMs, clockRttMs }: Props) {
  const lat = meta?.latency;
  const legP50 = percentile(browserLegSamples, 0.5);
  const legP95 = percentile(browserLegSamples, 0.95);
  const c = meta?.counters;

  return (
    <section className="panel">
      <h2>Latency &amp; feed health</h2>
      <dl className="stats">
        <div>
          <dt title="DraftKings odds-engine createdTime → our server receipt, corrected for the clock offset estimated from the subscribe round trip">
            DraftKings → server
          </dt>
          <dd>
            {lat && lat.samples > 0 ? (
              <>
                p50 <strong>{formatMs(lat.p50Ms)}</strong> · p95 {formatMs(lat.p95Ms)}{' '}
                <span className="muted">({lat.samples} updates)</span>
              </>
            ) : (
              <span className="muted">waiting for the first push update</span>
            )}
          </dd>
        </div>
        <div>
          <dt title="createdTime → websocketPublishTimestamp on DraftKings' own clocks (no skew involved), then socket publish → our receipt after skew correction">
            Breakdown
          </dt>
          <dd className="small">
            {lat && lat.samples > 0 ? (
              <>
                inside DraftKings p50 <strong>{formatMs(lat.pipelineP50Ms)}</strong> · network p50{' '}
                <strong>{formatMs(lat.transportP50Ms)}</strong> (min {formatMs(lat.transportMinMs)})
                ·{' '}
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
          <dt title="From the subscribe round trip (ack carries DraftKings' time), then refined continuously from every frame's publish timestamp; uncertainty ≈ RTT/2">
            Server ↔ DraftKings clock skew
          </dt>
          <dd>
            {lat?.clockSkewMs != null ? (
              <>
                {lat.clockSkewMs >= 0 ? '+' : ''}
                {lat.clockSkewMs} ms{' '}
                <span className="muted">
                  ({lat.skewSource === 'tracked' ? 'tracked from frames' : 'from subscribe ack'},
                  RTT {lat.skewRttMs} ms)
                </span>
              </>
            ) : (
              '—'
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
        <div>
          <dt>Feed</dt>
          <dd>
            {meta ? (
              <>
                {meta.feedState}
                {meta.socketConnectedAt && (
                  <span className="muted">
                    {' '}
                    · socket up since {new Date(meta.socketConnectedAt).toLocaleTimeString()}
                  </span>
                )}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        {c && (
          <div>
            <dt title="socket updates / snapshots / socket reconnects / drift corrections (changes a periodic snapshot found that the socket had not delivered — should stay 0) / stale-skips (snapshot fields ignored because the socket was newer)">
              Counters
            </dt>
            <dd className="small">
              {c.socketUpdates} push · {c.restSnapshots} snapshots · {c.socketReconnects} reconnects
              · {c.restFailures} REST failures ·{' '}
              <span className={c.driftCorrections > 0 ? 'warn-text' : ''}>
                {c.driftCorrections} drift
              </span>{' '}
              · {c.staleSnapshotSkips} stale-skips · {c.invalidEntities} invalid
            </dd>
          </div>
        )}
        {meta?.lastError && (
          <div>
            <dt>Last upstream error</dt>
            <dd className="small warn-text">
              {new Date(meta.lastError.at).toLocaleTimeString()} — {meta.lastError.message}
            </dd>
          </div>
        )}
      </dl>
      <p className="muted small">
        DraftKings stamps every push with its odds-engine <code>createdTime</code>; the number you
        see is that stamp to this screen, not a poll interval. Pushes usually arrive well under a
        second after the move; if the socket is down the page polls snapshots every 3 s and says so.
      </p>
    </section>
  );
}
