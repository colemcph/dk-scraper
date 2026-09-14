/**
 * Reachability probe: "can THIS host talk to DraftKings?"
 *
 *   npm run probe            # NFL, Ontario (defaults from .env / env vars)
 *   DK_LEAGUE_ID=84240 DK_SUBCATEGORY_ID=4519 npm run probe   # MLB (in-play most evenings)
 *
 * Fetches one snapshot, then holds a socket subscription for ~20 s and reports what arrived.
 * Run it from a fresh deploy before trusting the host: Akamai scores datacenter IPs differently
 * from residential ones, and this tells you in 30 seconds whether you're blocked.
 */
import { DK_LEAGUES, DraftKingsAdapter } from '../src/server/draftkings/adapter.js';
import { loadConfig } from '../src/server/config.js';
import { createLogger } from '../src/server/logger.js';

const config = loadConfig();
const logger = createLogger('warn', 'probe');
const known = Object.values(DK_LEAGUES).find((l) => l.id === config.dk.leagueId);
const league = {
  id: config.dk.leagueId,
  name: config.dk.leagueName || known?.name || config.dk.leagueId,
  subcategoryId: config.dk.subcategoryId,
};
const adapter = new DraftKingsAdapter({
  site: config.dk.site,
  wsRegion: config.dk.wsRegion,
  logger,
});

console.log(
  `probe: site=${config.dk.site} wsRegion=${config.dk.wsRegion} league=${league.name} (${league.id}/${league.subcategoryId}) node=${process.version}`,
);

let snapshotOk = false;
let spec: unknown;
try {
  const started = Date.now();
  const snap = await adapter.fetchSnapshot(league);
  snapshotOk = true;
  spec = snap.subscriptionSpec;
  const live = snap.games.filter((g) => g.status === 'live').length;
  console.log(
    `REST  ok  ${snap.games.length} games (${live} live), ${snap.invalidEntities} invalid entities, ${Date.now() - started} ms`,
  );
} catch (err) {
  console.log(`REST  FAIL ${err instanceof Error ? err.message : String(err)}`);
}

let updates = 0;
let acked = false;
const sub = adapter.subscribe(league, spec, {
  onDelta: () => {
    updates++;
  },
  onState: (state, detail) => {
    if (state === 'closed' && detail)
      console.log(`WS    closed code=${detail.code} reason=${detail.reason ?? ''}`);
  },
  onAck: ({ rttMs, skewMs }) => {
    acked = true;
    console.log(`WS    subscribed  rtt=${rttMs} ms  clockSkew=${Math.round(skewMs)} ms`);
  },
  onActivity: () => {},
  onError: (err) => console.log(`WS    error ${err.message}`),
});

await new Promise((r) => setTimeout(r, 20_000));
sub.close();
console.log(`WS    ${acked ? 'ok' : 'FAIL (no subscribe ack)'}  ${updates} update frames in 20 s`);
console.log(
  snapshotOk && acked
    ? 'RESULT: this host can use both DraftKings channels'
    : snapshotOk
      ? 'RESULT: snapshot works, socket does not -> the app will run in POLLING mode'
      : 'RESULT: DraftKings is blocking this host -> try another region/provider',
);
process.exit(snapshotOk ? 0 : 1);
