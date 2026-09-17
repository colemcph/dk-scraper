# DraftKings vs FanDuel NFL Live Odds — Betstamp take-home

> **Live:** https://betstamp-take-home.onrender.com/

**TL;DR of the choices**

| Question in the brief                | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| How do you get the data?             | **DraftKings:** the two channels their own web client uses — the **snapshot API** (`sportsbook-nash.draftkings.com/api/sportscontent/…`) to bootstrap and resync, and the **push WebSocket** (`sportsbook-ws-ca-on.draftkings.com/websocket`, JSON-RPC 2.0) for deltas. **FanDuel:** their page API (`sbapi.on.sportsbook.fanduel.ca/api/content-managed-page`) — FanDuel has **no public push feed** for sportsbook prices, so it is polled, cache-aware, with ETags. No headless browser, no third-party odds API. Both reverse-engineered from the books' JS bundles. |
| How old is the number on the screen? | **DraftKings:** sub-second on the push path — measured **odds engine → this screen ≈ 50–300 ms p50**, decomposed against their own timestamps with a self-check the page displays. **FanDuel:** a stated _bound_, not a measurement, because their payload carries no timestamps and sits behind a **30 s CDN cache**: **≤ 31 s** (max-age + one 1 s poll), shown on the page as such. See [Freshness](#how-fresh-are-the-odds).                                                                                                                                         |
| Auth, cookies, geo, bot protection?  | Neither book needs a login, token or cookie. DraftKings: **Akamai TLS fingerprinting** (curl → 403, Node → 200), a Canadian IP served the Ontario product, a msgpack-by-default socket that also speaks JSON. FanDuel: **no bot protection at all** (curl 200), a public `_ak` key baked into their bundle, the US API refusing Canadian IPs (400) so the `.ca` Ontario host is used, and a CloudFront cache that is the real limit. Details in [What I hit](#what-i-hit-and-how-i-got-around-it).                                                                       |
| Snapshot or delta?                   | DraftKings: both — the REST API is a full picture every time; the socket is **deltas only**, tracked with indices. FanDuel: **snapshot only**, every poll a full picture (or a 304 saying nothing changed), diffed by the same store. See [Shape of the data](#shape-of-the-data).                                                                                                                                                                                                                                                                                       |
| Comparing the books?                 | Every game is matched across books through a **canonical NFL team registry** (DraftKings "DET Lions" = FanDuel "Detroit Lions"), the better price is marked when the lines agree, each book's hold is shown, and a **"who moved first"** tracker pairs the same move seen at both books. See [Comparing the books](#comparing-the-books).                                                                                                                                                                                                                                |
| Doesn't break when a book misbehaves | Lenient validation, backoff, socket→polling fallback, last-known-good always served, one state machine per book so a FanDuel outage never touches DraftKings' LIVE state, and a UI that says LIVE / POLLING / STALE / DEGRADED per book instead of quietly showing old numbers. See [Failure modes](#failure-modes).                                                                                                                                                                                                                                                     |

---

## Contents

- [Run it locally](#run-it-locally)
- [How it works](#how-it-works)
- [Why this approach](#why-this-approach)
- [How fresh are the odds](#how-fresh-are-the-odds)
- [What I hit and how I got around it](#what-i-hit-and-how-i-got-around-it)
- [Shape of the data](#shape-of-the-data)
- [Comparing the books](#comparing-the-books)
- [Failure modes](#failure-modes)
- [HTTP API](#http-api)
- [Configuration](#configuration)
- [Testing](#testing)
- [Deploying](#deploying)
- [Adding a third sportsbook or a league](#adding-a-third-sportsbook-or-a-league)
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
- API: <http://localhost:3000/api/odds> · stream: <http://localhost:3000/api/stream> · comparison: <http://localhost:3000/api/compare>

`npm run dev` runs the API (`node --watch --import tsx`) and Vite side by side. The first browser connection can land a second before the API is up; the page's `EventSource` retries by itself.

> **Windows / PowerShell:** if you see `running scripts is disabled on this system`, that's PowerShell's execution policy blocking `npm.ps1`, not the project. Either use `npm.cmd ci` / `npm.cmd run dev`, or run once `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

Production build (what Render runs):

```bash
npm run build && npm start      # serves UI + API on :3000
```

Docker:

```bash
docker build -t odds . && docker run -p 3000:3000 odds
```

Check whether the machine you're on can reach the books at all:

```bash
npm run probe            # DraftKings: snapshot + 20 s on the socket (30 s)
npm run probe:fanduel    # FanDuel: curl vs Node, one read, a 304, then the CDN cache cycle (45 s)
```

Everything is configurable through environment variables — copy `.env.example` to `.env`. Defaults are DraftKings **Ontario** (`DK_SITE=dkcaon`, `DK_WS_REGION=ca-on`, NFL `88808`, main lines subcategory `4518`) and FanDuel **Ontario** (`FD_REGION=on`, page `nfl`). `FD_ENABLED=false` runs DraftKings alone.

---

## How it works

```
        DraftKings                                      this service (one Node process)                                  browsers
 ┌──────────────────────────────┐        ┌─────────────────────────────────────────────────────────────────┐        ┌──────────────────┐
 │ sportsbook-nash.draftkings   │◄───────┤ draftkings/rest.ts   snapshot (boot/resync)                     │        │ React            │
 │  /api/sportscontent/dkcaon/  │        │ draftkings/ws.ts     JSON-RPC subscribe, ping, reconnect        │  SSE   │  Compare tab:    │
 │  v1/leagues/88808            │        │        │ normalize.ts                                           │ ─────► │  both books per  │
 └──────────────────────────────┘        │        ▼                                                        │        │  game, best price│
 ┌──────────────────────────────┐        │ store.ts ─┐                                                     │        │  who moved first │
 │ sportsbook-ws-ca-on          │───────►│ feed.ts   │ (DraftKings: LIVE state machine)                    │        │  DK tab / FD tab │
 │  /websocket?format=json      │        │           ├──── ChangeSet ────► sse.ts (one stream, per-book)   │  REST  │  flashes, prev   │
 └──────────────────────────────┘        │ store.ts ─┘                     moves.ts (recent moves, both)   │ ◄────► │  price, LIVE /   │
        FanDuel                          │ feed.ts     (FanDuel: POLLING state machine)                    │        │  POLLING / STALE │
 ┌──────────────────────────────┐        │        ▲ normalize.ts                                           │        │  per book,       │
 │ sbapi.on.sportsbook.fanduel  │◄───────┤ fanduel/rest.ts      ETag polls, sleeps through the CDN's       │        │  latency panel   │
 │  .ca/api/content-managed-page│        │                      max-age, 304 when nothing changed          │        └──────────────────┘
 │  (behind CloudFront, 30 s)   │        │ api.ts  /api/odds /api/stream /api/compare /api/refresh …       │
 └──────────────────────────────┘        │ shared/compare.ts + shared/teams.ts   (matching, also in the UI)│
                                         └─────────────────────────────────────────────────────────────────┘
```

1. **Bootstrap.** `GET …/leagues/88808` returns DraftKings' already-relational payload — `events[]`, `markets[]`, `selections[]` — scoped to main lines (75 games × Moneyline/Spread/Total = 225 markets, 450 selections, ~390 KB). `normalize.ts` maps it to the domain model below; the store indexes every selection id.
2. **Subscribe.** The same payload carries `subscriptionPartials["league-events-88808"]`: the exact OData filter DraftKings' client uses. We send it as a JSON-RPC `subscribe` on `wss://sportsbook-ws-ca-on.draftkings.com/websocket?format=json` and get an ack with DraftKings' server time (used for clock-skew estimation).
3. **Deltas.** Every update frame is `{add, change, remove} × {events, markets, selections}` plus `metadata.createdTime` (DraftKings' odds engine) and `websocketPublishTimestamp`. The store applies it, produces a `ChangeSet` (what changed, previous value, timestamps), and the SSE hub broadcasts it to every browser.
4. **Resync.** Every 60 s while live, on every socket reconnect, when the manual Refresh is pressed, and whenever a delta references an id we don't know, the snapshot is re-fetched and **diffed** against the store. The diff is broadcast like any other change and counted as _drift_ — proof that delta tracking is correct (it has stayed at 0).
5. **FanDuel.** A second `FeedManager` with its own store polls `content-managed-page?customPageId=nfl` (~1 MB, 32 games, all three main markets each, plus futures we ignore). The response says `Cache-Control: max-age=30` and how old the edge copy already is (`Age`), so the adapter **sleeps until the copy can change, then polls once a second with `If-None-Match`** until the ETag turns over. An unchanged page is a ~200-byte 304 in ~10 ms; a changed one is diffed by the same store code DraftKings uses, so line moves flash and land in "Recent moves" identically.
6. **Compare.** `shared/compare.ts` pairs games across books (canonical team ids + kickoff window), marks the best price per side when the lines agree, computes each book's hold, and pairs "the same move" seen at both books to say who showed it first. It is pure and runs in the browser off the SSE state, and on the server for `/api/compare`.
7. **Browser.** One `EventSource`: a `snapshot` per book on connect, `delta` per change (ids are a hub-wide sequence so reconnects replay what was missed across both books), `meta` on state transitions and polls, `heartbeat` every 10 s with every book's state. The page estimates its own clock offset from `/api/time` so "3 s ago" is on the server's clock.

### Feed state machine

One instance per book:

```
 BOOTSTRAPPING ──snapshot ok──► LIVE (socket subscribed) ──socket closed──► RECONNECTING ──> wsFallbackAfterMs──► POLLING (snapshot every 3 s)
      │                          ▲        │                                        │                                    │
      │ snapshot fails           │        └── every 60 s / unknown id / Refresh ── RESYNC                               │ socket recovers
      ▼                          │                                                                                      │
   DEGRADED (retry w/ backoff, serve last-known-good if any) ◄── snapshot fails while polling                           ▼
                                 └─────────────────────────────────────────────────────────────── LIVE (+ gap-filling resync)
 any state: no successful contact with the book for 90 s ⇒ meta.stale = true ⇒ STALE banner for that book

 FanDuel (no push feed): BOOTSTRAPPING ──page ok──► POLLING (cache-aware, ETag) ◄──► DEGRADED. POLLING is its healthy state and the UI says so (green).
```

### Domain model (`src/shared/types.ts`)

```ts
Game    { id, book: 'draftkings'|'fanduel', league, startTime, status: 'upcoming'|'live'|'finished', home, away, live?, markets: { moneyline, spread, total }, updatedAt }
Market  { type, sides: { home|away|over|under → Side }, suspended, updatedAt, sourceMarketId }
Side    { key, label, line?, odds: { american, decimal }, prev?: { line?, odds, changedAt }, updatedAt, sourceSelectionId }
```

`prev` is what makes "was −112" and the up/down arrows possible; `updatedAt` on a socket-driven change is DraftKings' `createdTime`, on a FanDuel change it is our poll time (FanDuel gives us nothing better). `FeedMeta.transport` (`push` | `poll`) and `FeedMeta.poll` (cache max-age, Age, ETag, next poll) are how the UI explains each book's freshness honestly.

---

## Why this approach

| Option                                           | Latency                       | Reliability                        | Effort | Verdict                                                                                      |
| ------------------------------------------------ | ----------------------------- | ---------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| **Snapshot API polling**                         | poll interval + 1 s CDN cache | High, simple                       | Low    | **DraftKings: bootstrap, resync, fallback**                                                  |
| **Delta WebSocket** (what DraftKings' site uses) | **sub-second**                | High once connected; needs indices | Medium | **DraftKings: primary live channel**                                                         |
| **Cache-aware ETag polling**                     | ≤ CDN max-age + poll interval | High, simple                       | Low    | **FanDuel: the only public channel**                                                         |
| Headless browser (Playwright) scraping the page  | seconds; heavy CPU/RAM        | Brittle to DOM changes             | Medium | Escape hatch only (its request context is a fallback if Node's TLS fingerprint gets blocked) |

The DraftKings hybrid is what their front end does (snapshot BFF + "Longshot" socket), gives one upstream connection regardless of visitor count, and the REST channel doubles as a correctness oracle. It was chosen after an evening of reconnaissance rather than by assumption: I grepped DraftKings' JS bundles for the socket URL and protocol, then subscribed from Node and watched 74 deltas arrive in 30 s on in-play games before writing a line of app code.

FanDuel was approached the same way. Their bundle _does_ open a WebSocket (`wss://pir.{REGION}.sportsbook.fanduel.ca/graphql/realtime`, an AWS AppSync subscription called `OnUpdateMarketPrice`), which is exactly the kind of thing you'd hope to find — but its neighbours in the bundle are `PlaceBuyOrder` and `GetOrderCalculation`: it is their **prediction-market** product, with its own auth key, not the sportsbook. So the premise "FanDuel has no WebSocket" holds for prices, and the question became _how fast can you poll a page that sits behind a 30 s CDN cache without being rude_ — answered in [Freshness](#how-fresh-are-the-odds).

### Why Node

DraftKings sits behind Akamai, which fingerprints the TLS client. From the same machine, same headers:

| Client                          | `GET …/leagues/88808` (DraftKings)           | `GET …/content-managed-page` (FanDuel)  |
| ------------------------------- | -------------------------------------------- | --------------------------------------- |
| `curl 7.78` (Chrome User-Agent) | **403** `Access Denied` (Akamai reference #) | **200**                                 |
| Node 22 `fetch` (undici)        | **200**, 392 KB JSON                         | **200**, 1 MB JSON (brotli on the wire) |
| Node 22 `WebSocket` / `ws`      | connects, subscribes, streams                | n/a                                     |

Python `requests`/`httpx` would be in the curl bucket for DraftKings (fixable with `curl_cffi`-style impersonation, but that's a dependency and a fragility I don't need). Node's stack passes as-is, and one language covers the server, the socket client and the React UI. The whole runtime dependency list is `hono`, `ws`, `zod`, `react`.

### Why SSE to the browser (not a WebSocket)

Server → browser is one-directional. `EventSource` reconnects on its own, resumes with `Last-Event-ID`, needs no library, and streams fine through Render's proxy. The Refresh button is a plain `POST`.

### Why one process

A free-tier box can hold one socket to DraftKings, one polite poller on FanDuel, and fan out to any number of tabs. Serverless/static hosts (Vercel, Netlify, GitHub Pages) can't keep the upstream socket open and would force per-request polling — worse latency and N× the load on both books.

---

## How fresh are the odds

### DraftKings

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

"contact _n_ s ago" per book in the status strip is the honest answer to "how old could the number be": no line is older than that.

### FanDuel

FanDuel's page carries **no timestamps** — not on events, markets or prices — and there is no push feed, so there is nothing to measure a latency _against_. What there is, is a hard bound, and the page states it as one:

- The API sits behind CloudFront with `Cache-Control: public, max-age=30, stale-while-revalidate=60`. The copy any client receives can be **up to 30 s old**, whatever its poll rate. Measured from Toronto, 40 requests at one per second: every response an edge hit in **7–16 ms**, the `Age` header climbing 16, 17, … 28, 30 and resetting to 1 — a clean sawtooth — and the ETag unchanged throughout (a quiet Thursday evening; `npm run probe:fanduel` prints this cycle).
- `If-None-Match` works at the edge: an unchanged page is a **304 in ~10 ms with no body**, so polling is nearly free. Their own web client, for comparison, re-fetches this page every 10 s in play and every 30–60 s otherwise (`pollingInterval:g?3e4:1e4`, `refetchInterval:6e4` in their bundle) — this service sees a new edge copy sooner than FanDuel's own site does.
- The adapter is **cache-aware** (`fanduel/adapter.ts`, `nextPollDelayMs`): after any response it sleeps `max-age − Age` — the edge copy cannot change before then — and only then polls once a second with the ETag until the copy turns over. Freshness is identical to hammering at 1 Hz; the cost is ~2–3 tiny requests per 30 s instead of 30 (the probe reports "would have made 2 requests instead of 40"). In 40 s the deployed server made 5 requests: 2 bodies, 3 not-modified.
- **Bound shown on the page: ≤ max-age + one poll interval = ≤ 31 s.** The latency panel also shows the copy we hold's generation time (`Date − Age`, the CDN's clock), its age at receipt, the last status (200/304) and the next scheduled poll.
- **`FD_CACHE_BYPASS=true`** appends a unique query string so every poll reaches FanDuel's origin. Measured: `X-Cache: Miss from cloudfront`, ~300 ms, and — on a quiet evening — the same ETag as the edge copy. It is the only way under the 30 s bound and it is off by default: from a service that runs around the clock it turns edge hits into origin requests, and whether the origin is actually ahead of the edge can only be shown while prices are moving (the probe's step 5 measures it). One env var for the interview demo; not the polite default.

**What "who moved first" can and cannot say.** The tracker pairs the same move (same new line, or same direction) seen at both books within 120 s and reports the lead. DraftKings' time is their engine stamp; FanDuel's is when this service saw it behind the cache. A FanDuel "lead" means the number was public on FanDuel first; a DraftKings lead of under ~30 s says nothing about which trader moved first. The panel says this in its own footnote.

---

## What I hit and how I got around it

### DraftKings

**Akamai bot management (TLS fingerprinting).** Every API host returns an instant Akamai `Access Denied` to curl, regardless of headers or cookies — it's the ClientHello, not the request. Node's undici passes. To stay boring I also send the headers a browser tab would (`Origin`, `Referer`, `Accept-Language: en-CA`) and replay any cookie the edge sets (`ak_bmsc`, 2 h) via a tiny cookie jar, so the service looks like one long-lived tab. The page loads Akamai's sensor script and could start requiring the `_abck` challenge cookie on the API at any time; that would show up as 403s, flip the feed to DEGRADED with last-known-good data, and the documented escape hatch is a Playwright `request` context (Chromium's real TLS stack, no page rendering) behind the same `fetchImpl` seam.

**Auth, cookies, tokens.** None required: no login, `jwt: ""` is accepted on the socket, the REST call works with no cookie. So nothing expires. If DraftKings _starts_ requiring one, it surfaces as HTTP 401/403 or socket close code `4000` (their "bad query params — terminal" code), the feed degrades visibly instead of crashing, and the fix is a token requester behind the adapter's existing seams.

**msgpack.** DraftKings' site opens the socket with `format=msgpack`. The same library has a JSON path, and the server honours `format=json`, so no binary decoding was needed. If they ever drop JSON, the app automatically falls back to POLLING and stays correct; adding `@msgpack/msgpack` decoding is a bounded follow-up.

**Small sharp edges.** `displayOdds.american` uses **U+2212** (Unicode minus), not `-`; prices are taken from the numeric `trueOdds` instead. Kickoff times have 7 fractional digits. Event names are `AWAY @ HOME`. The socket server closes idle connections (their client uses a 5 s inactivity code `4002`), so we ping every 15 s and force a reconnect after 45 s of silence.

**Rate limits.** None encountered. A bounded probe (20 requests at 1/s, then 20 at 4/s) returned 40 × HTTP 200 with no `Retry-After`. What it did show is the 1-second edge cache: at 4/s the `Date` header repeated and responses came back in ~19 ms — the same cached copy — while at 1/s every response was a fresh origin hit. That cache, not a quota, is the effective limit on REST freshness, and it is why polling faster than 1/s buys nothing. I deliberately did not push further (sustained 10+/s, parallel sockets): the socket makes it pointless for the product, and Akamai keeps IP reputation.

### FanDuel

**No bot protection, no auth.** `curl` and Node both get 200 from `sbapi.on.sportsbook.fanduel.ca` with no cookie. The only credential is `_ak=FhMFpcPWXMeyZxOx`, a constant in their `main.*.js`, sent by every visitor (overridable via `FD_API_KEY` if they rotate it). The service still sends browser-like headers, and the real site's `Origin` on purpose: the response says `Vary: Origin`, so that header is part of the CDN cache key — using the same one as real browsers means we share the copy their traffic keeps warm instead of forcing our own.

**Geo.** The US API (`api.sportsbook.fanduel.com/sbapi/…`) answers a Canadian IP with an empty 400 generated by CloudFront. The Canadian site sets an `X-Sportsbook-Region=on` cookie and calls `sbapi.{state}.sportsbook.fanduel.ca`; region `on` is the default here and a one-var change elsewhere.

**The socket that isn't one.** Their bundle references `wss://pir.{REGION}.sportsbook.fanduel.{com,ca}/graphql/realtime` with `aws_appsync_authenticationType: PIR_AUTH_KEY` and a `subscription OnUpdateMarketPrice`. Tempting, but the surrounding code is `PlaceBuyOrder`, `GetOrderCalculation`, `markets/prediction-markets` — their prediction-market product, keyed separately. Not the sportsbook, so not used.

**The cache is the contract.** `max-age=30, stale-while-revalidate=60`, `ETag`, `Age`, `X-Cache`. One quirk seen in the probe: exactly at the boundary (`Age: 30`) the edge answered a conditional request with a **200 and the same ETag** — stale-while-revalidate handing over the refreshed copy — which the store diffs and finds unchanged. Harmless, and why 200s are counted separately from 304s in the panel.

**Small sharp edges.** Events are `AWAY @ HOME` like DraftKings, but the FanDuel kickoff is listed a minute later (17:01 for a 17:00 game). `handicap` carries the spread (signed per side) and the total; it is `0` on a moneyline. A runner's `selectionId` repeats across a team's markets, so the store id is `marketId:selectionId`. The page mixes 142 markets of 18 types; only `MONEY_LINE`, `MATCH_HANDICAP_(2-WAY)` and `TOTAL_POINTS_(OVER/UNDER)` are read, everything else (futures, specials) is ignored without being counted as invalid. `marketStatus` and `runnerStatus` carry suspension (`SUSPENDED`) and closure (`CLOSED`); `inPlay` marks live games — no scores or clocks on this page (their `event-page/{id}/score` endpoint has them; not in scope).

**Rate limits.** None seen at 1/s for 40 s or during the 5-request bursts in reconnaissance. `Retry-After` on 429/503 is parsed anyway and shows up as the feed's last error.

---

## Shape of the data

### DraftKings

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

### FanDuel

**Page = full picture, keyed by id, no timestamps.** Trimmed from the real capture (`fixtures/fd-page-nfl.json` keeps four games and one futures event):

```jsonc
{ "attachments": {
    "events":  { "35599552": { "eventId": 35599552, "name": "Detroit Lions @ Buffalo Bills",
                               "openDate": "2026-09-18T00:15:00.000Z", "competitionId": 12282733 } },
    "markets": { "801.168781244": {
        "marketId": "801.168781244", "eventId": 35599552, "marketName": "Moneyline",
        "marketType": "MONEY_LINE", "marketStatus": "OPEN", "inPlay": false,
        "runners": [
          { "selectionId": 50193, "handicap": 0, "runnerName": "Detroit Lions", "nameAbbr": "DET Lions",
            "result": { "type": "AWAY" }, "runnerStatus": "ACTIVE",
            "winRunnerOdds": { "americanDisplayOdds": { "americanOdds": 205 },
                               "trueOdds": { "decimalOdds": { "decimalOdds": 3.05 } } } },
          { "selectionId": 50203, "handicap": 0, "runnerName": "Buffalo Bills", "result": { "type": "HOME" }, … } ] },
      "801.168781242": { "marketType": "MATCH_HANDICAP_(2-WAY)", "runners": [ { "handicap": 5.5, … }, { "handicap": -5.5, … } ] },
      "801.168781245": { "marketType": "TOTAL_POINTS_(OVER/UNDER)", "runners": [ { "runnerName": "Over", "handicap": 54.5, "result": { "type": "OVER" }, … }, … ] } } } }
```

`result.type` (`HOME`/`AWAY`/`OVER`/`UNDER`) places every runner without name matching; `nameAbbr` happens to be DraftKings' label style, so both books read the same in the table.

---

## Comparing the books

**Entity resolution.** `src/shared/teams.ts` is a 32-team registry (id, city, nickname, colour, aliases). Every NFL nickname is unique, so any spelling resolves by its tail: "DET Lions", "Detroit Lions", "LA Chargers", "Los Angeles Chargers", "NY Jets", "Washington Football Team", "Bucs" all land. A name that does not resolve is **never guessed** — the pair is kept on raw names and flagged `resolved: false` — because comparing two different games is worse than comparing none. Games pair on `${away}@${home}` canonical ids within a 24 h kickoff window, at most one game per book per pair (`src/shared/compare.ts`). On the deployed instance: 32 FanDuel games, 32 DraftKings games, 32 pairs, all resolved.

**Prices.** For each side of each market the Compare tab shows both books' prices stacked with a DK/FD badge. When the books quote the **same line**, the higher decimal price is marked as best and the tooltip gives the edge, the implied probability and that book's hold (`1/d₁ + 1/d₂ − 1`). When the lines differ (a −3.5 at −110 versus a −4 at +100) the cell is marked instead and no "best" is called. Ties and suspended prices are excluded. A game only one book lists shows a dash for the other.

**Moves.** Every price change from either book lands in "Recent moves" with its badge and source (`push` / `snapshot` / `poll`). "Who moved first?" pairs the same destination (same new line, or same direction of price change) at the two books within 120 s, counts leads per book and reports the median lead, in the browser off its own history and on the server from a 2-hour ring buffer (`/api/compare`). The caveat about FanDuel's cache is printed under it.

---

## Failure modes

| What breaks                                              | What the service does                                                                                       | What you see                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A book unreachable at startup (403/5xx/timeout)          | Retries with jittered backoff (1 → 30 s); serves an empty state as `degraded` for that book                 | "Waiting for DraftKings/FanDuel… retrying" with the last error |
| DraftKings REST fails after startup                      | Keeps last-known-good; socket keeps running; `lastSnapshotAt` ages                                          | Table intact; last error in the latency panel                  |
| DraftKings socket closes (`1000/1006/1013/4001/4002`)    | Reconnects with jittered backoff (1 s → 15 s cap), resubscribes, then resyncs to fill the gap               | LIVE → RECONNECTING → LIVE                                     |
| DraftKings socket down > 15 s                            | POLLING every 3 s; keeps trying the socket in the background                                                | Amber POLLING pill on the DK badge                             |
| DraftKings socket alive but silent                       | Ping every 15 s; forced reconnect after 45 s idle; 60 s resync catches anything missed (counted as drift)   | Nothing, unless it crosses the stale threshold                 |
| Delta references an unknown id                           | Counted (`unresolvedDeltas`), resync scheduled                                                              | Nothing — the resync heals it                                  |
| FanDuel returns 5xx / times out / 429 with `Retry-After` | That feed alone goes `degraded`, keeps last-known-good, keeps polling; DraftKings' state is untouched       | Red DEGRADED pill on the FD badge; DK still LIVE               |
| FanDuel answers 304 for a long time                      | Normal: it is contact (never stale), no delta, `restNotModified` climbs                                     | "last → 304 not modified" in the panel                         |
| Payload has an unexpected shape                          | Lenient `zod` schemas with passthrough; bad entities dropped and counted, never thrown                      | A "—" in a cell at worst; `invalidEntities` in the panel       |
| A book changes the contract entirely                     | Validation fails → `degraded` with last-known-good, for that book                                           | Red DEGRADED banner with the time of the last good data        |
| No contact with a book for 90 s                          | `meta.stale = true` for that book                                                                           | Red STALE banner naming the book                               |
| Browser loses the stream                                 | `EventSource` auto-reconnect + `Last-Event-ID` replay (200-delta buffer across books), 35 s client watchdog | "RECONNECTING to this server" pill                             |

---

## HTTP API

| Route                  | Purpose                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/odds`        | Every book's normalized state: `{ serverTime, books: { draftkings: { version, games[], meta }, fanduel: … } }`                     |
| `GET /api/odds/:book`  | One book: `{ version, games[], meta }`                                                                                             |
| `GET /api/compare`     | Matched games with both books' prices, best price and hold per market, and the "who moved first" pairing                           |
| `GET /api/stream`      | SSE: `snapshot` per book → `delta`\* (+ `meta`, `heartbeat`); every event carries `meta.book`. Supports `Last-Event-ID`            |
| `POST /api/refresh`    | Forces a snapshot resync of every book (or `?book=fanduel`); each feed limits itself to once per 5 s; `429` only when all refused  |
| `GET /api/time`        | Server time, for the browser's clock-offset estimate                                                                               |
| `GET /api/metrics`     | Per book: latency percentiles, counters, poll/cache stats; SSE client count                                                        |
| `GET /api/diagnostics` | Same plus config and process info — the "can this host reach the books?" page                                                      |
| `GET /healthz`         | `{ ok, books: { draftkings: { feedState, stale, lastContactAt }, fanduel: … } }` — Render's health check and the keep-alive pinger |

---

## Configuration

| Variable                                            | Default                             | Meaning                                                                                        |
| --------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `DK_SITE`                                           | `dkcaon`                            | DraftKings site key (Ontario). US: `dkusoh`, `dkusnj`, `dkuswv`, …                             |
| `DK_WS_REGION`                                      | `ca-on`                             | Socket host: `sportsbook-ws-{region}.draftkings.com`                                           |
| `DK_LEAGUE_ID`                                      | `88808`                             | NFL. (MLB `84240`, handy for testing on a weeknight)                                           |
| `DK_SUBCATEGORY_ID`                                 | `4518`                              | "Game" under "Game Lines" = the main markets. (MLB `4519`)                                     |
| `FD_ENABLED`                                        | `true`                              | `false` runs DraftKings only                                                                   |
| `FD_REGION`                                         | `on`                                | FanDuel region: `sbapi.{region}.sportsbook.fanduel.ca`                                         |
| `FD_PAGE_ID`                                        | `nfl`                               | FanDuel's `customPageId` for the league                                                        |
| `FD_POLL_INTERVAL_MS`                               | `1000`                              | Fast poll cadence around the CDN copy's expiry; the adapter sleeps through `max-age` otherwise |
| `FD_CACHE_BYPASS`                                   | `false`                             | `true` = unique query string per poll, every poll is a FanDuel origin request (see Freshness)  |
| `FD_API_KEY`, `FD_TIMEZONE`                         | their public key, `America/Toronto` | Only if FanDuel rotates the key / you move regions                                             |
| `RESYNC_INTERVAL_MS`                                | `60000`                             | DraftKings snapshot cadence while live (liveness proof + drift check)                          |
| `POLL_INTERVAL_MS`                                  | `3000`                              | DraftKings snapshot cadence when the socket is unavailable                                     |
| `WS_FALLBACK_AFTER_MS`                              | `15000`                             | How long to wait for the socket before polling                                                 |
| `STALE_AFTER_MS`                                    | `90000`                             | No successful exchange with a book for this long ⇒ that book is stale                          |
| `HEARTBEAT_INTERVAL_MS`                             | `10000`                             | SSE heartbeat                                                                                  |
| `DK_REST_BASE_URL`, `DK_WS_URL`, `FD_REST_BASE_URL` | unset                               | Point the app at mock books (what `npm run chaos` does)                                        |
| `REFRESH_MIN_INTERVAL_MS`                           | `5000`                              | Per-book rate limit for the Refresh button                                                     |
| `PORT`, `LOG_LEVEL`                                 | `3000`, `info`                      |                                                                                                |

---

## Testing

```bash
npm test               # vitest, 102 tests, < 2 s
npm run chaos          # end-to-end resilience run against a mock DraftKings + mock FanDuel (~60 s, offline)
npm run probe          # DraftKings: can this host reach the snapshot API and the socket?
npm run probe:fanduel  # FanDuel: curl vs Node, one read, a 304, the CDN cache cycle; FD_CACHE_BYPASS=true adds origin reads
npm run latency        # 45 s on the real DraftKings socket: inside-DraftKings vs network legs, with the skew self-check
npm run frames         # print DraftKings' raw socket frames as JSON for 30 s (the browser shows them as binary msgpack)
npm run demo           # guided 3-act interview demo: why Node (curl 403 vs Node 200), how the feed is derived, live latency
npm run lint           # eslint (typescript-eslint strict-ish)
npm run typecheck      # server (NodeNext) + web (bundler) projects
```

- `test/normalize.test.ts` — the real 75-game DraftKings payload and the real socket frames: every market/side mapped, U+2212, malformed entities dropped, non-main markets ignored, `replacedSelectionId`/`isSuspended`/remove lists.
- `test/fanduel.test.ts` — the real FanDuel page: every game with canonical teams, lines and both odds formats; suspension, closed markets, in-play flags, malformed runners counted, futures ignored, unknown teams kept usable; the HTTP client's URL/headers, `If-None-Match` → 304, cache bypass, 429 with `Retry-After`, non-JSON; the cache-header parsers; the cache-aware scheduling math and the adapter's freshness stats.
- `test/compare.test.ts` — the team registry (every spelling both books use, ambiguity refused, 32 unique nicknames); game matching across spellings and a one-minute kickoff gap, single-book games, the same matchup a week apart, unresolved names; best price / edge / hold, no best across different lines, ties or suspended prices; move pairing (order, window, direction, same-book, unknown game, at-most-once).
- `test/store.test.ts` — snapshot diffing, `prev` history, delta resolution by id / replaced id / market+side, unresolved reporting, idempotency, suspension, removal, and snapshot/delta ordering (an older snapshot cannot overwrite a newer socket write).
- `test/feed.test.ts` — the state machine with a fake adapter and fake timers: bootstrap backoff, socket → polling fallback and recovery with gap-filling resync, latency attribution with skew, unresolved → resync, stale flag, refresh rate limit, drift counting; poll-only adapters: 304 as contact without a delta, the poll hint followed and clamped both ways, an outage as `degraded` with last-known-good and recovery.
- `test/ws.test.ts` — the socket client with a fake socket: subscribe payload, NTP-style skew from the ack, malformed frames, exponential backoff and reset, silence watchdog, clean stop.
- `test/sse.test.ts` — a snapshot per book on connect, one id sequence across books, heartbeats with every book's state, `Last-Event-ID` replay vs. fresh snapshots, dropping dead clients.
- `test/latency.test.ts` — skew correction math, continuous skew tracking across a clock step, and percentiles.
- `test/api.test.ts` — the HTTP routes in-process: the odds bundle and per-book snapshot, health per book, time, Refresh semantics (per-book results, 429 + `Retry-After` only when all refuse), the stream opening with a snapshot per book, diagnostics/metrics per book, `/api/compare` matching a game across books and calling who moved first, and a handler error becoming a 500 instead of a crash.
- `test/ui.test.tsx` — the React components rendered to HTML: every side/line/price in both odds formats, the dash for an unoffered market, the `SUSP` state, previous price + flash, day grouping and live score/period; the Compare table with both books per cell, the best price marked, differing lines flagged and a dash for a book that does not list the game; the lead tracker; the state pill for every feed condition per transport and the FanDuel freshness bound; the client reducer keeping books apart through snapshots, deltas, flashes, moves and heartbeats.

### Chaos run (end-to-end, no book involved)

`scripts/chaos.ts` starts a fake DraftKings snapshot API + socket and a fake FanDuel page API (with `max-age`, `Age`, `ETag` and 304s like the real CDN) on localhost, points the **real built server** at them, and walks it through the failure modes the brief asks about, reporting what `/healthz` and `/api/odds` say at each step. CI runs it on every push. Output from the run that accompanied this README:

```
fixtures: DraftKings DET Lions ML = −325, FanDuel DET Lions ML = +205
1a boot: snapshots from both mocks                 DK=live          FD=polling         games=75/4  DET ML DK=-325  FD=205   304s=0
1b DK socket pushed DET ML -> -300; FD polling     DK=live          FD=polling         games=75/4  DET ML DK=-300  FD=205   304s=1
2a DK socket killed                                DK=reconnecting  FD=polling         games=75/4  DET ML DK=-300  FD=205   304s=2   lastError(DK)=socket error: connect ECONNREFUSED
2b DK socket still down (> fallback window)        DK=polling       FD=polling         games=75/4  DET ML DK=-300  FD=205   304s=4   lastError(DK)=socket error: connect ECONNREFUSED
3  DK snapshot API returns HTML                    DK=degraded      FD=polling         games=75/4  DET ML DK=-300  FD=205   304s=5   lastError(DK)=DraftKings returned non-JSON (39 b
4a DK snapshot API returns HTTP 500                DK=degraded/STALE FD=polling         games=75/4  DET ML DK=-300  FD=205   304s=7   lastError(DK)=DraftKings HTTP 500 for http://127
4b ... 8 s with no DK contact at all               DK=degraded/STALE FD=polling         games=75/4  DET ML DK=-300  FD=205   304s=9   lastError(DK)=DraftKings HTTP 500 for http://127
5a DK snapshot API back, DET ML now -350           DK=polling       FD=polling         games=75/4  DET ML DK=-350  FD=205   304s=10  lastError(DK)=DraftKings HTTP 500 for http://127
5b FD moved DET ML +205 -> +220 behind its cache   DK=polling       FD=polling         games=75/4  DET ML DK=-350  FD=220   304s=11  lastError(DK)=DraftKings HTTP 500 for http://127
5c FD API returns HTTP 500 (DK untouched)          DK=polling       FD=degraded        games=75/4  DET ML DK=-350  FD=220   304s=11  lastError(FD)=FanDuel HTTP 500 for http://127.0.
5d FD API back                                     DK=polling       FD=polling         games=75/4  DET ML DK=-350  FD=220   304s=13  lastError(FD)=FanDuel HTTP 500 for http://127.0.
6  DK socket back (reconnect backoff capped at 15 s) DK=live          FD=polling         games=75/4  DET ML DK=-350  FD=220   304s=21  lastError(FD)=FanDuel HTTP 500 for http://127.0.
```

The `304s` column is FanDuel's not-modified count climbing while nothing changed; step 5b is a price change behind the mock's 2 s `max-age` picked up by the next poll; 5c/5d are a FanDuel outage that leaves DraftKings' column untouched.

Nothing in CI touches DraftKings or FanDuel. `npm run probe` and `npm run probe:fanduel` are the opt-in live contract checks.

---

## Deploying

The repo carries a **Render Blueprint** (`render.yaml`, free web service, Ohio region, both books enabled) and a **Dockerfile** (works unchanged on Fly.io/Koyeb/anything that runs a container).

Deployed on Render's free tier from `render.yaml`. Free instances sleep after 15 idle minutes; a GitHub Actions job (`.github/workflows/keepalive.yml`) pings `/healthz` every 10 minutes to keep it warm.

---

## Adding a third sportsbook or a league

**Second league.** DraftKings scopes everything by `leagueId` + main-lines `subcategoryId` (NFL `88808/4518`, MLB `84240/4519` — both verified); FanDuel by page id (`nfl`, `nba`, `mlb`, `nhl`). `DK_LEAGUES` / `FD_LEAGUES` in the adapters become registries, the socket client multiplexes one `subscribe` per league on the same connection (JSON-RPC ids are per subscription), the store keys games by `(book, league, id)`, the SSE stream gains a `league` field, and the UI gets league tabs. The one genuinely new piece per league is a team registry like `shared/teams.ts` — nickname uniqueness is an NFL property, MLB needs city + nickname.

**Third sportsbook.** Implement `BookAdapter` (`src/server/book.ts`):

```ts
interface BookAdapter {
  book: BookId;
  site: string;
  transport: 'push' | 'poll';
  fetchSnapshot(league): Promise<SnapshotResult>; // required; may answer { notModified: true, nextPollInMs }
  subscribe?(league, spec, handlers): Subscription; // optional: omit it and the manager polls
  pollStats?(): PollStats; // optional: what the UI shows about freshness
}
```

Add the id to `BookId`, a `FeedManager` + `OddsStore` in `index.ts`, a badge colour — the hub, the API, the comparison and the UI are already keyed by book. FanDuel is the worked example of a poll-only adapter (`src/server/fanduel/`): ~120 lines of REST client, ~200 of normalizer, ~130 of scheduling and stats. The hard part remains **entity resolution**, and for the NFL it is done: any new book's spellings go into `teams.ts` aliases.

## Where AI and tooling would help this scale

## Project layout

```
src/
  shared/
    types.ts           domain model shared by server and UI (BookId, Game, FeedMeta, PollStats …)
    teams.ts           canonical NFL team registry (ids, nicknames, aliases, colours)
    compare.ts         cross-book matching, best price / hold, "who moved first" (pure; used by server and UI)
    odds.ts            american ⇄ decimal
  server/
    index.ts           wiring: one adapter + store + FeedManager per book, one hub, graceful shutdown
    config.ts  logger.ts  http.ts (browser UA, cache-header parsers)
    book.ts            BookAdapter contract + NormalizedDelta (the seam for another sportsbook)
    draftkings/
      adapter.ts       the DraftKings adapter (+ league registry)
      rest.ts          snapshot client (browser-like headers, cookie jar, timeout)
      ws.ts            JSON-RPC socket client (subscribe, ping, backoff, skew)
      schema.ts        lenient zod schemas for DraftKings payloads
      normalize.ts     DraftKings → domain (snapshot and delta)
    fanduel/
      adapter.ts       the FanDuel adapter: cache-aware poll scheduling, freshness stats (+ page registry)
      rest.ts          page client (ETag / If-None-Match, Cache-Control, Age, Retry-After, optional cache bypass)
      schema.ts        lenient zod schemas for the content-managed-page payload
      normalize.ts     FanDuel → domain
    store.ts           in-memory state per book: snapshot diff, delta apply, id indices, ordering guard
    feed.ts            state machine per book: bootstrap, socket, resync, polling (hinted), stale
    latency.ts         clock-skew tracking and percentiles
    moves.ts           recent moves across books (for /api/compare)
    sse.ts             one stream for every book, replay buffer, heartbeats
    api.ts             HTTP routes + static UI
  web/
    App.tsx  main.tsx  index.html  styles.css
    useOddsFeed.ts     EventSource, per-book state, reconnect, clock offset, flashes
    format.ts  timeSync.ts
    components/        CompareTable, OddsTable, OddsCell, StatusStrip, RecentMoves, LeadTracker, LatencyPanel, BookBadge
fixtures/              real DraftKings payloads (2026-09-12) and a trimmed real FanDuel page (2026-09-17)
test/                  vitest (one file per module; fanduel + compare cover the new pieces)
scripts/probe.ts       "can this host reach DraftKings?"
scripts/fanduel-probe.ts  "what does this host see from FanDuel's page API?" (reachability, 304s, the cache cycle)
scripts/chaos.ts       end-to-end resilience run against a mock DraftKings + mock FanDuel
scripts/latency.ts  frames.ts  demo.ts   DraftKings socket instrumentation and the interview demo
docs/DECISIONS.md      decision log
```
