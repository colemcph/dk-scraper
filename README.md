# DraftKings NFL Live Odds — Betstamp take-home

> **Live:** https://betstamp-take-home.onrender.com/

**TL;DR of the choices**

| Question in the brief                    | Answer                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How do you get the data?                 | The two channels DraftKings' own web client uses: their **snapshot API** (`sportsbook-nash.draftkings.com/api/sportscontent/…`) to bootstrap and resync, and their **push WebSocket** (`sportsbook-ws-ca-on.draftkings.com/websocket`, JSON-RPC 2.0) for deltas. No headless browser, no third-party odds API. Reverse-engineered from their `dk-data-layer` bundle. |
| How old is the number on the screen?     | Sub-second on the push path. Measured on in-play games: **DraftKings odds engine → this screen ≈ 50–300 ms p50, ≈ 0.5 s p95**, decomposed against DraftKings' own timestamps with a self-check the page displays (see [Freshness](#how-fresh-are-the-odds)). Not a poll interval.                                                                                    |
| Auth, cookies, geo, bot protection?      | No login/token/cookie is needed. What I hit: **Akamai TLS fingerprinting** (curl → 403, Node → 200), a Canadian IP being served the Ontario product, and a msgpack-by-default socket that also speaks JSON. Details in [What I hit](#what-i-hit-and-how-i-got-around-it).                                                                                            |
| Snapshot or delta?                       | Both: the REST API is a full picture every time; the socket is **deltas only** — changed selections arrive without a market id and line moves arrive as a _new_ selection id with `replacedSelectionId`. The store keeps indices to place them and asks for a resync if it ever can't. See [Shape of the data](#shape-of-the-data).                                  |
| Doesn't break when DraftKings misbehaves | Lenient validation, backoff, socket→polling fallback, last-known-good always served, and a UI that says LIVE / POLLING / STALE / DEGRADED instead of quietly showing old numbers. See [Failure modes](#failure-modes).                                                                                                                                               |

---

## Contents

- [Run it locally](#run-it-locally)
- [How it works](#how-it-works)
- [Why this approach](#why-this-approach)
- [How fresh are the odds](#how-fresh-are-the-odds)
- [What I hit and how I got around it](#what-i-hit-and-how-i-got-around-it)
- [Shape of the data](#shape-of-the-data)
- [Failure modes](#failure-modes)
- [HTTP API](#http-api)
- [Configuration](#configuration)
- [Testing](#testing)
- [Deploying](#deploying)
- [Adding a second sportsbook or league](#adding-a-second-sportsbook-or-league)
- [Where AI and tooling would help this scale](#where-ai-and-tooling-would-help-this-scale)
- [Project layout](#project-layout)

---

## Run it locally

Requires **Node 22+** (the built-in `fetch`/`WebSocket` matter — see [Why Node](#why-node)).

```bash
npm ci
npm run dev
```

- UI: <http://localhost:5173> (Vite dev server, proxies `/api` to the backend)
- API: <http://localhost:3000/api/odds> · stream: <http://localhost:3000/api/stream>

`npm run dev` runs the API (`node --watch --import tsx`) and Vite side by side. The first browser connection can land a second before the API is up; the page's `EventSource` retries by itself.

> **Windows / PowerShell:** if you see `running scripts is disabled on this system`, that's PowerShell's execution policy blocking `npm.ps1`, not the project. Either use `npm.cmd ci` / `npm.cmd run dev`, or run once `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

Production build (what Render runs):

```bash
npm run build && npm start      # serves UI + API on :3000
```

Docker:

```bash
docker build -t dk-odds . && docker run -p 3000:3000 dk-odds
```

Check whether the machine you're on can reach DraftKings at all (30 s):

```bash
npm run probe
```

Everything is configurable through environment variables — copy `.env.example` to `.env`. Defaults are DraftKings **Ontario** (`DK_SITE=dkcaon`, `DK_WS_REGION=ca-on`) and the NFL (`88808`, main lines subcategory `4518`).

---

## How it works

```
                DraftKings                                   this service (one Node process)                          browsers
 ┌─────────────────────────────────┐        ┌──────────────────────────────────────────────────────┐        ┌────────────────┐
 │ sportsbook-nash.draftkings.com  │◄───────┤ draftkings/rest.ts           snapshot (boot/resync)  │        │ React table    │
 │  /api/sportscontent/dkcaon/v1/  │        │                                                      │  SSE   │ flashes, prev  │
 │  leagues/88808   (full picture) │        │ draftkings/ws.ts             JSON-RPC subscribe,     │ ─────► │ price, LIVE /  │
 └─────────────────────────────────┘        │                              ping, reconnect         │        │ STALE, latency │
 ┌─────────────────────────────────┐        │        │ normalize.ts  (DraftKings → Game/Market/Side)│  REST  │ Refresh button │
 │ sportsbook-ws-ca-on.draftkings  │───────►│        ▼                                             │ ◄────► │                │
 │  /websocket?format=json (deltas)│        │ store.ts ──── ChangeSet ────► sse.ts (fan-out)       │        └────────────────┘
 └─────────────────────────────────┘        │ feed.ts       state machine · resync · stale         │
                                            │ api.ts        /api/odds /api/stream /api/refresh …   │
                                            └──────────────────────────────────────────────────────┘
```

1. **Bootstrap.** `GET …/leagues/88808` returns DraftKings' already-relational payload — `events[]`, `markets[]`, `selections[]` — scoped to main lines (75 games × Moneyline/Spread/Total = 225 markets, 450 selections, ~390 KB). `normalize.ts` maps it to the domain model below; the store indexes every selection id.
2. **Subscribe.** The same payload carries `subscriptionPartials["league-events-88808"]`: the exact OData filter DraftKings' client uses. We send it as a JSON-RPC `subscribe` on `wss://sportsbook-ws-ca-on.draftkings.com/websocket?format=json` and get an ack with DraftKings' server time (used for clock-skew estimation).
3. **Deltas.** Every update frame is `{add, change, remove} × {events, markets, selections}` plus `metadata.createdTime` (DraftKings' odds engine) and `websocketPublishTimestamp`. The store applies it, produces a `ChangeSet` (what changed, previous value, timestamps), and the SSE hub broadcasts it to every browser.
4. **Resync.** Every 60 s while live, on every socket reconnect, when the manual Refresh is pressed, and whenever a delta references an id we don't know, the snapshot is re-fetched and **diffed** against the store. The diff is broadcast like any other change and counted as _drift_ — proof that delta tracking is correct (it has stayed at 0).
5. **Browser.** One `EventSource`: `snapshot` on connect, `delta` per change (id = store version, so reconnects replay what was missed), `meta` on state transitions, `heartbeat` every 10 s. The page estimates its own clock offset from `/api/time` so "3 s ago" is on the server's clock.

### Feed state machine

```
 BOOTSTRAPPING ──snapshot ok──► LIVE (socket subscribed) ──socket closed──► RECONNECTING ──> wsFallbackAfterMs──► POLLING (snapshot every 3 s)
      │                          ▲        │                                        │                                    │
      │ snapshot fails           │        └── every 60 s / unknown id / Refresh ── RESYNC                               │ socket recovers
      ▼                          │                                                                                      │
   DEGRADED (retry w/ backoff, serve last-known-good if any) ◄── snapshot fails while polling                           ▼
                                 └─────────────────────────────────────────────────────────────── LIVE (+ gap-filling resync)
 any state: no successful DraftKings contact for 90 s ⇒ meta.stale = true ⇒ STALE banner
```

### Domain model (`src/shared/types.ts`)

```ts
Game    { id, book, league, startTime, status: 'upcoming'|'live'|'finished', home, away, live?, markets: { moneyline, spread, total }, updatedAt }
Market  { type, sides: { home|away|over|under → Side }, suspended, updatedAt, sourceMarketId }
Side    { key, label, line?, odds: { american, decimal }, prev?: { line?, odds, changedAt }, updatedAt, sourceSelectionId }
```

`prev` is what makes "was −112" and the up/down arrows possible; `updatedAt` on a socket-driven change is DraftKings' `createdTime`, not ours.

---

## Why this approach

| Option                                           | Latency                       | Reliability                        | Effort | Verdict                                                                                      |
| ------------------------------------------------ | ----------------------------- | ---------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| **Snapshot API polling**                         | poll interval + 1 s CDN cache | High, simple                       | Low    | **Bootstrap, resync, fallback**                                                              |
| **Delta WebSocket** (what DraftKings' site uses) | **sub-second**                | High once connected; needs indices | Medium | **Primary live channel**                                                                     |
| Headless browser (Playwright) scraping the page  | seconds; heavy CPU/RAM        | Brittle to DOM changes             | Medium | Escape hatch only (its request context is a fallback if Node's TLS fingerprint gets blocked) |

The hybrid is what DraftKings' front end does (snapshot BFF + "Longshot" socket), gives one upstream connection regardless of visitor count, and the REST channel doubles as a correctness oracle. It was chosen after an evening of reconnaissance rather than by assumption: I grepped DraftKings' JS bundles for the socket URL and protocol, then subscribed from Node and watched 74 deltas arrive in 30 s on in-play games before writing a line of app code.

### Why Node

DraftKings sits behind Akamai, which fingerprints the TLS client. From the same machine, same headers:

| Client                          | `GET …/leagues/88808`                        |
| ------------------------------- | -------------------------------------------- |
| `curl 7.78` (Chrome User-Agent) | **403** `Access Denied` (Akamai reference #) |
| Node 22 `fetch` (undici)        | **200**, 392 KB JSON                         |
| Node 22 `WebSocket` / `ws`      | connects, subscribes, streams                |

Python `requests`/`httpx` would be in the curl bucket (fixable with `curl_cffi`-style impersonation, but that's a dependency and a fragility I don't need). Node's stack passes as-is, and one language covers the server, the socket client and the React UI. The whole runtime dependency list is `hono`, `ws`, `zod`, `react`.

### Why SSE to the browser (not a WebSocket)

Server → browser is one-directional. `EventSource` reconnects on its own, resumes with `Last-Event-ID`, needs no library, and streams fine through Render's proxy. The Refresh button is a plain `POST`.

### Why one process

A free-tier box can hold one socket to DraftKings and fan out to any number of tabs. Serverless/static hosts (Vercel, Netlify, GitHub Pages) can't keep the upstream socket open and would force per-request polling — worse latency and N× the load on DraftKings.

---

## How fresh are the odds

Three clocks are involved (DraftKings', the server's, the browser's):

- **DraftKings stamps every delta** with `metadata.createdTime` (odds engine) and `websocketPublishTimestamp` (socket layer). Their internal pipeline is ~60 ms.
- **Server ↔ DraftKings skew** is estimated NTP-style from the subscribe round trip (their ack carries their time; RTT/2 ≈ 20 ms is the uncertainty) and then **refined continuously** from every frame: `receipt − publish` over a 10-minute window has a floor of `−skew + one-way`, so the estimate follows the frames even if the host clock steps mid-session (which the development PC did — it was 1.85 s behind DraftKings' clock at one point and re-synced later).
- **Self-check, shown on the page:** after correction, the pure network leg (DraftKings socket publish → our receipt) must be small and never negative. If the skew were wrong it would go negative or balloon. Tonight: **min 12 / p50 15 / p95 42 ms, 0 negative of 25**, against a measured RTT/2 of 19 ms.
- **Browser ↔ server skew** is estimated the same way from `/api/time`.
- Reported per update: `dkToServerMs = receive − (createdTime − skew)` and `serverToBrowserMs = (browserReceive − browserOffset) − emittedAt`. p50/p95 over the last 1,000 updates are in the status strip; each entry in "Recent moves" shows its own breakdown.

**Measured** (Toronto residential connection → DraftKings Ontario; in-play MLB because NFL lines don't move on a Friday night). DraftKings' own timestamps let the number be decomposed:

| Leg                                                            | min   | p50            | p95     | n   |
| -------------------------------------------------------------- | ----- | -------------- | ------- | --- |
| Inside DraftKings: odds engine → their publish stage           | 7 ms  | 8 ms           | 8 ms    | 25  |
| Inside DraftKings: publish stage → socket send (they batch)    | 12 ms | 30 ms          | ~430 ms | 25  |
| Network: socket send → this server (skew-corrected)            | 12 ms | 15 ms          | 42 ms   | 25  |
| **DraftKings engine → this server, quiet feed (1 live game)**  | 42 ms | **51 ms**      | 470 ms  | 25  |
| **DraftKings engine → this server, busy feed (10 live games)** | —     | **224–307 ms** | 567 ms  | 99  |
| Server → browser (same machine)                                | —     | 2 ms           | 5 ms    | 58  |

So on the push path a move is on screen **~50–300 ms** after DraftKings' engine stamps it; the tail is their batching, which their own website also waits for (and their client additionally throttles DOM updates to 500 ms). Our own processing is under 1 ms per frame.

_(Numbers from the deployed Render instance will replace these once the Week 1 Sunday slate has run; the panel on the page always shows the live figures and the breakdown.)_

Bounds in the other states:

- **POLLING** (socket unavailable): ≤ 3 s poll + ≤ 1 s CDN cache (`cache-control: public, max-age=1`) ⇒ **≤ ~4 s**.
- **Silently dead socket**: caught by the 45 s inactivity watchdog or the 60 s resync, whichever first.
- **STALE** is declared after 90 s without any successful exchange; the banner names the time of the last confirmed data.

"DraftKings contact _n_ s ago" in the status strip is the honest answer to "how old could the number be": no line is older than that.

---

## What I hit and how I got around it

**Akamai bot management (TLS fingerprinting).** Every API host returns an instant Akamai `Access Denied` to curl, regardless of headers or cookies — it's the ClientHello, not the request. Node's undici passes. To stay boring I also send the headers a browser tab would (`Origin`, `Referer`, `Accept-Language: en-CA`) and replay any cookie the edge sets (`ak_bmsc`, 2 h) via a tiny cookie jar, so the service looks like one long-lived tab. The page loads Akamai's sensor script and could start requiring the `_abck` challenge cookie on the API at any time; that would show up as 403s, flip the feed to DEGRADED with last-known-good data, and the documented escape hatch is a Playwright `request` context (Chromium's real TLS stack, no page rendering) behind the same `fetchImpl` seam.

**Auth, cookies, tokens.** None required: no login, `jwt: ""` is accepted on the socket, the REST call works with no cookie. So nothing expires. If DraftKings _starts_ requiring one, it surfaces as HTTP 401/403 or socket close code `4000` (their "bad query params — terminal" code), the feed degrades visibly instead of crashing, and the fix is a token requester behind the adapter's existing seams.

**msgpack.** DraftKings' site opens the socket with `format=msgpack`. The same library has a JSON path, and the server honours `format=json`, so no binary decoding was needed. If they ever drop JSON, the app automatically falls back to POLLING and stays correct; adding `@msgpack/msgpack` decoding is a bounded follow-up.

**Small sharp edges.** `displayOdds.american` uses **U+2212** (Unicode minus), not `-`; prices are taken from the numeric `trueOdds` instead. Kickoff times have 7 fractional digits. Event names are `AWAY @ HOME`. The socket server closes idle connections (their client uses a 5 s inactivity code `4002`), so we ping every 15 s and force a reconnect after 45 s of silence.

**Rate limits.** None encountered. A bounded probe (20 requests at 1/s, then 20 at 4/s) returned 40 × HTTP 200 with no `Retry-After`. What it did show is the 1-second edge cache: at 4/s the `Date` header repeated and responses came back in ~19 ms — the same cached copy — while at 1/s every response was a fresh origin hit. That cache, not a quota, is the effective limit on REST freshness, and it is why polling faster than 1/s buys nothing. I deliberately did not push further (sustained 10+/s, parallel sockets): the socket makes it pointless for the product, and Akamai keeps IP reputation.
---

## Shape of the data

**Snapshot = full picture.** Every call returns all events/markets/selections for the league; the store diffs it against what it has.

**Socket = deltas only, and you track the rest.** Real frames (kept in `fixtures/dk-socket-frames.json`):

```jsonc
// a price change: no marketId, no outcomeType — you must already know this selection
{ "event": "update", "data": { "data": { "change": { "selections": [
  { "id": "0ML86275348_1", "label": "STL Cardinals", "trueOdds": 1.89285715, "displayOdds": { "american": "−112" } } ] } },
  "metadata": { "createdTime": "2026-09-13T01:20:14.205Z", "publishedTime": "…14.248Z" } },
  "websocketPublishTimestamp": "2026-09-13T01:20:14.267588+00:00" }

// a line move: a NEW selection id (the id encodes the line) replacing the old one
{ "add": { "selections": [ { "id": "0OU86275332U1150_3", "marketId": "3_86275332", "points": 11.5,
                              "replacedSelectionId": "0OU86275332U1050_3", … } ] } }

// a suspension: no eventId at all
{ "change": { "markets": [ { "id": "1_86275334", "isSuspended": true } ] } }

// a removal: bare ids
{ "remove": { "selections": [ "0HC86275332N750_1" ] } }
```

**Verified on a live NFL game** (Sunday Night Football, Week 1): status `STARTED`, period labels like `"1st Quarter"`, a `gameTime` countdown in seconds (rendered as the clock beside the period), the same three main-market ids carried from pre-game into live play, `firstTeamScore`/`secondTeamScore` confirmed as away/home against an independent scoreboard, 132 socket frames in two minutes (79 selection changes, 6 add/remove pairs for line moves, 4 suspensions) — all handled by the paths above — and finished games disappearing from the snapshot, which is what drops them from the table.

---

## Failure modes

| What breaks                                         | What the service does                                                                                     | What you see                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| DraftKings unreachable at startup (403/5xx/timeout) | Retries with jittered backoff (1 → 30 s); serves an empty state as `degraded`                             | "Waiting for DraftKings… retrying" with the last error   |
| REST fails after startup                            | Keeps last-known-good; socket keeps running; `lastSnapshotAt` ages                                        | Table intact; last error in the latency panel            |
| Socket closes (`1000/1006/1013/4001/4002`)          | Reconnects with jittered backoff (1 s → 15 s cap), resubscribes, then resyncs to fill the gap             | LIVE → RECONNECTING → LIVE                               |
| Socket down > 15 s                                  | POLLING every 3 s; keeps trying the socket in the background                                              | Amber POLLING pill                                       |
| Socket alive but silent                             | Ping every 15 s; forced reconnect after 45 s idle; 60 s resync catches anything missed (counted as drift) | Nothing, unless it crosses the stale threshold           |
| Delta references an unknown id                      | Counted (`unresolvedDeltas`), resync scheduled                                                            | Nothing — the resync heals it                            |
| Payload has an unexpected shape                     | Lenient `zod` schemas with passthrough; bad entities dropped and counted, never thrown                    | A "—" in a cell at worst; `invalidEntities` in the panel |
| DraftKings changes the contract entirely            | Validation fails → `degraded` with last-known-good                                                        | Red DEGRADED banner with the time of the last good data  |
| No contact for 90 s                                 | `meta.stale = true`                                                                                       | Red STALE banner                                         |
| Browser loses the stream                            | `EventSource` auto-reconnect + `Last-Event-ID` replay (200-delta buffer), 35 s client watchdog            | "RECONNECTING to this server" pill                       |

---

## HTTP API

| Route                  | Purpose                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /api/odds`        | Full normalized state: `{ version, games[], meta }`                                             |
| `GET /api/stream`      | SSE: `snapshot` → `delta`\* (+ `meta`, `heartbeat`). Supports `Last-Event-ID`                   |
| `POST /api/refresh`    | Forces a snapshot resync; `429` when called more than once per 5 s globally                     |
| `GET /api/time`        | Server time, for the browser's clock-offset estimate                                            |
| `GET /api/metrics`     | Latency percentiles, counters, SSE client count                                                 |
| `GET /api/diagnostics` | Same plus config and process info — the "can this host reach DraftKings?" page                  |
| `GET /healthz`         | `{ ok, feedState, stale, lastContactAt }` — for Render's health check and the keep-alive pinger |

---

## Configuration

| Variable                        | Default        | Meaning                                                            |
| ------------------------------- | -------------- | ------------------------------------------------------------------ |
| `DK_SITE`                       | `dkcaon`       | DraftKings site key (Ontario). US: `dkusoh`, `dkusnj`, `dkuswv`, … |
| `DK_WS_REGION`                  | `ca-on`        | Socket host: `sportsbook-ws-{region}.draftkings.com`               |
| `DK_LEAGUE_ID`                  | `88808`        | NFL. (MLB `84240`, handy for testing on a weeknight)               |
| `DK_SUBCATEGORY_ID`             | `4518`         | "Game" under "Game Lines" = the main markets. (MLB `4519`)         |
| `RESYNC_INTERVAL_MS`            | `60000`        | Snapshot cadence while live (liveness proof + drift check)         |
| `POLL_INTERVAL_MS`              | `3000`         | Snapshot cadence when the socket is unavailable                    |
| `WS_FALLBACK_AFTER_MS`          | `15000`        | How long to wait for the socket before polling                     |
| `STALE_AFTER_MS`                | `90000`        | No successful DraftKings exchange for this long ⇒ stale            |
| `HEARTBEAT_INTERVAL_MS`         | `10000`        | SSE heartbeat                                                      |
| `DK_REST_BASE_URL`, `DK_WS_URL` | unset          | Point the app at a mock DraftKings (what `npm run chaos` does)     |
| `REFRESH_MIN_INTERVAL_MS`       | `5000`         | Global rate limit for the Refresh button                           |
| `PORT`, `LOG_LEVEL`             | `3000`, `info` |                                                                    |

---

## Testing

```bash
npm test          # vitest, 68 tests, < 2 s
npm run chaos     # end-to-end resilience run against a mock DraftKings (~45 s, offline)
npm run latency   # 45 s on the real socket: inside-DraftKings vs network legs, with the skew self-check
npm run frames    # print DraftKings' raw socket frames as JSON for 30 s (the browser shows them as binary msgpack)
npm run demo      # guided 3-act interview demo: why Node (curl 403 vs Node 200), how the feed is derived, live latency
npm run lint      # eslint (typescript-eslint strict-ish)
npm run typecheck # server (NodeNext) + web (bundler) projects
```

- `test/normalize.test.ts` — the real 75-game NFL payload and the real socket frames: every market/side mapped, U+2212, malformed entities dropped, non-main markets ignored, `replacedSelectionId`/`isSuspended`/remove lists.
- `test/store.test.ts` — snapshot diffing, `prev` history, delta resolution by id / replaced id / market+side, unresolved reporting, idempotency, suspension, removal, and snapshot/delta ordering (an older snapshot cannot overwrite a newer socket write).
- `test/feed.test.ts` — the state machine with a fake adapter and fake timers: bootstrap backoff, socket → polling fallback and recovery with gap-filling resync, latency attribution with skew, unresolved → resync, stale flag, refresh rate limit, drift counting, polling-only adapters.
- `test/ws.test.ts` — the socket client with a fake socket: subscribe payload, NTP-style skew from the ack, malformed frames, exponential backoff and reset, silence watchdog, clean stop.
- `test/sse.test.ts` — snapshot on connect, versioned deltas, heartbeats, `Last-Event-ID` replay vs. fresh snapshot, dropping dead clients.
- `test/latency.test.ts` — skew correction math, continuous skew tracking across a clock step, and percentiles.
- `test/api.test.ts` — the HTTP routes in-process: snapshot, health, time, Refresh rate limit (429 + `Retry-After`), SSE stream opening with a snapshot, diagnostics, and a handler error becoming a 500 instead of a crash.
- `test/ui.test.tsx` — the React components rendered to HTML: every side/line/price in both odds formats, the dash for an unoffered market, the `SUSP` state, previous price + flash, day grouping and live score/period; the state pill for every feed condition; the client reducer applying deltas, flashes, moves, browser-leg latency and heartbeats.

### Chaos run (end-to-end, no DraftKings involved)

`scripts/chaos.ts` starts a fake snapshot API and a fake socket on localhost, points the **real built server** at them (`DK_REST_BASE_URL`, `DK_WS_URL`), and walks it through the failure modes the brief asks about, reporting what `/healthz` and `/api/odds` say at each step. CI runs it on every push. Output from the run that accompanied this README:

```
1a boot: snapshot from mock                          state=live         stale=false games=75  DET ML=-325
1b socket pushed DET ML -> -300                      state=live         stale=false games=75  DET ML=-300
2a socket killed                                     state=reconnecting stale=false games=75  DET ML=-300
2b socket still down (> fallback window)             state=polling      stale=false games=75  DET ML=-300
3  snapshot API returns HTML                         state=degraded     stale=false games=75  DET ML=-300  lastError=DraftKings returned non-JSON
4a snapshot API returns HTTP 500                     state=degraded     stale=true  games=75  DET ML=-300  lastError=DraftKings HTTP 500
4b ... 8 s with no contact at all                    state=degraded     stale=true  games=75  DET ML=-300
5  snapshot API back, DET ML now -350                state=polling      stale=false games=75  DET ML=-350
6  socket back (reconnect backoff is capped at 15 s) state=live         stale=false games=75  DET ML=-350
```

Nothing in CI touches DraftKings. `npm run probe` is the opt-in live contract check.

---

## Deploying

The repo carries a **Render Blueprint** (`render.yaml`, free web service, Ohio region) and a **Dockerfile** (works unchanged on Fly.io/Koyeb/anything that runs a container).

Deployed on Render's free tier from `render.yaml` Free instances sleep after 15 idle minutes; a GitHub Actions job (`.github/workflows/keepalive.yml`) pings `/healthz` every 10 minutes to keep it warm.
---

## Adding a second sportsbook or league

**Second league** DraftKings scopes everything by `leagueId` + main-lines `subcategoryId` (NFL `88808/4518`, MLB `84240/4519` — both verified). `DK_LEAGUES` in `draftkings/adapter.ts` becomes a registry, the socket client multiplexes one `subscribe` per league on the same connection (JSON-RPC ids are per subscription), the store keys games by `(book, league, id)`, the SSE stream gains a `league` field, and the UI gets tabs. Nothing in the store or the UI is NFL-specific today.

**Second sportsbook.** Implement `BookAdapter` (`src/server/book.ts`):

```ts
interface BookAdapter {
  fetchSnapshot(league): Promise<SnapshotResult>; // required
  subscribe?(league, spec, handlers): Subscription; // optional: omit it and the manager polls
}
```

A `FeedManager` per adapter, all feeding the same hub. A polling-only book is already supported (that's the POLLING state). The hard part isn't the transport — it's **entity resolution** across books: "LA Chargers" vs "Los Angeles Chargers", a total of 49.5 vs "O/U 49.5", kickoff times that differ by a minute. That wants a canonical `Team`/`Event` registry keyed by league + normalized names + kickoff window, with per-book alias tables — and it's where tooling earns its keep.

## Where AI and tooling would help this scale

## Project layout

```
src/
  shared/types.ts        domain model shared by server and UI
  server/
    index.ts             wiring + graceful shutdown
    config.ts  logger.ts
    book.ts              BookAdapter contract + NormalizedDelta (the seam for a second sportsbook)
    draftkings/
      adapter.ts         the DraftKings adapter (+ league registry)
      rest.ts            snapshot client (browser-like headers, cookie jar, timeout)
      ws.ts              JSON-RPC socket client (subscribe, ping, backoff, skew)
      schema.ts          lenient zod schemas for DraftKings payloads
      normalize.ts       DraftKings → domain (snapshot and delta)
    store.ts             in-memory state: snapshot diff, delta apply, id indices, ordering guard
    feed.ts              state machine: bootstrap, socket, resync, polling fallback, stale
    latency.ts           clock-skew tracking and percentiles
    sse.ts               fan-out to browsers, replay buffer, heartbeats
    api.ts               HTTP routes + static UI
  web/
    App.tsx  main.tsx  index.html  styles.css
    useOddsFeed.ts       EventSource, reconnect, clock offset, flashes
    format.ts  timeSync.ts
    components/          OddsTable, OddsCell, StatusStrip, RecentMoves, LatencyPanel
fixtures/                real DraftKings payloads captured 2026-09-12
test/                    vitest (one file per server module)
scripts/probe.ts         "can this host reach DraftKings?"
scripts/chaos.ts         end-to-end resilience run against a mock DraftKings
docs/DECISIONS.md        decision log
```
