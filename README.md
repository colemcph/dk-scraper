# DraftKings vs FanDuel NFL Live Odds — Betstamp take-home

> **Live:** https://betstamp-take-home.onrender.com/

**TL;DR of the choices**

| Question in the brief                | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How do you get the data?             | **DraftKings:** the two channels their own web client uses — the **snapshot API** (`sportsbook-nash.draftkings.com/api/sportscontent/…`) to bootstrap and resync, and the **push WebSocket** (`sportsbook-ws-ca-on.draftkings.com/websocket`, JSON-RPC 2.0) for deltas. **FanDuel:** no public push feed for sportsbook prices, so two polled channels — their page API (`content-managed-page`) for structure, and the uncached `getMarketPrices` endpoint their own betslip uses for live prices. No headless browser, no third-party odds API. Both reverse-engineered from the books' JS bundles. |
| How old is the number on the screen? | **DraftKings:** sub-second on the push path — measured **odds engine → this screen ≈ 50–300 ms p50**, decomposed against their own timestamps with a self-check the page displays. **FanDuel:** a stated _bound_, not a measurement (their payload carries no timestamps): **≈ 5 s**, from polling the uncached `getMarketPrices` endpoint their own client uses for the betslip, at the 5 s cadence they use. Shown on the page as a bound. See [Freshness](#how-fresh-are-the-odds).                                                                                                                |
| Auth, cookies, geo, bot protection?  | Neither book needs a login, token or cookie. DraftKings: **Akamai TLS fingerprinting** (curl → 403, Node → 200), a Canadian IP served the Ontario product, a msgpack-by-default socket that also speaks JSON. FanDuel: **no bot protection at all** (curl 200), a public `_ak` key baked into their bundle, the US API refusing Canadian IPs (400) so the `.ca` Ontario host is used, and a CloudFront cache that is the real limit. Details in [What I hit](#what-i-hit-and-how-i-got-around-it).                                                                                                    |
| Snapshot or delta?                   | DraftKings: both — the REST API is a full picture every time; the socket is **deltas only**, tracked with indices. FanDuel: **snapshot only**, every poll a full picture (or a 304 saying nothing changed), diffed by the same store. See [Shape of the data](#shape-of-the-data).                                                                                                                                                                                                                                                                                                                    |
| Comparing the books?                 | Every game is matched across books through a **canonical NFL team registry** (DraftKings "DET Lions" = FanDuel "Detroit Lions"), the better price is marked when the lines agree, each book's hold is shown, and a **"who moved first"** tracker pairs the same move seen at both books. See [Comparing the books](#comparing-the-books).                                                                                                                                                                                                                                                             |
| Doesn't break when a book misbehaves | Lenient validation, backoff, socket→polling fallback, last-known-good always served, one state machine per book so a FanDuel outage never touches DraftKings' LIVE state, and a UI that says LIVE / POLLING / STALE / DEGRADED per book instead of quietly showing old numbers. See [Failure modes](#failure-modes).                                                                                                                                                                                                                                                                                  |

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

**Measured on the deployed instance** (Render Ohio → DraftKings Ontario) during Thursday Night Football, Week 3 — 469 push updates across one in-play game and a pre-game board. DraftKings' own timestamps let the number be decomposed:

| Leg                                                          | min   | p50        | p95      | n   |
| ------------------------------------------------------------ | ----- | ---------- | -------- | --- |
| Network: their socket publish → this server (skew-corrected) | 17 ms | **20 ms**  | —        | 469 |
| Inside DraftKings: odds engine → socket publish              | —     | **632 ms** | —        | 469 |
| **DraftKings engine → this server, all updates**             | —     | **651 ms** | 1 754 ms | 469 |
| — of which, in-play                                          | —     | 503 ms     | 1 452 ms | 354 |
| — of which, pre-game                                         | —     | 1 011 ms   | 3 005 ms | 115 |
| Server → browser                                             | —     | 2–6 ms     | —        | —   |

The shape is the point: **the network leg is 20 ms and essentially all of the rest — 632 of 651 ms — happens inside DraftKings**, between their odds engine stamping a price and their socket publishing it. That is their batching, and their own website waits for exactly the same publish (their client then throttles DOM updates by a further 500 ms). There is no faster public path; the only way to beat it would be a commercial feed.

Two things worth noting from this run. The skew estimate had converged to **+2 ms** (tracked from frames, RTT 35 ms) and the self-check held: **0 of 469 network samples came out negative**, which is what says the correction is honest rather than flattering. And pre-game updates were _slower_ than in-play ones that night (1 011 ms vs 503 ms) — the publish delay tracks how much work their engine is doing, not whether a given game is live, which is why the panel splits the two instead of claiming a single figure.

Bounds in the other states:

- **POLLING** (socket unavailable): ≤ 3 s poll + ≤ 1 s CDN cache (`cache-control: public, max-age=1`) ⇒ **≤ ~4 s**.
- **Silently dead socket**: caught by the 45 s inactivity watchdog or the 60 s resync, whichever first.
- **STALE** is declared after 90 s without any successful exchange; the banner names the time of the last confirmed data.

"contact _n_ s ago" per book in the status strip is the honest answer to "how old could the number be": no line is older than that.

### FanDuel

FanDuel publishes **no timestamps** — not on events, markets or prices — and has no push feed for sportsbook odds, so there is nothing to measure a latency _against_. What there is, is a hard bound, and the page states it as one. Getting that bound down was the whole game, and it came down to finding the right endpoint.

**Two channels, not one.** The obvious source, the coupon page (`content-managed-page`), sits behind CloudFront with `Cache-Control: public, max-age=30`: the copy any client receives can be up to 30 s old _whatever its poll rate_, so nothing built on it alone can beat ≈30 s. But their own client does better than that, and the way in is the betslip: put a selection in it and the page starts polling something else.

```
POST https://smp.on.sportsbook.fanduel.ca/api/sports/fixedodds/readonly/v1/getMarketPrices
{ "marketIds": ["801.168781244", ...] }        ->  Cache-Control: no-cache
```

Found in their bundle as `HighPriorityMarketPricing` / `fetchSmp`, with `pollingConfig: { refreshTimeInMs: 5000, batchSize: 70 }`. Measured against the live endpoint:

|                       | Coupon page                                     | `getMarketPrices`                                                          |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| Cache                 | `max-age=30` (CloudFront)                       | **`no-cache`**                                                             |
| Response              | ~45 ms edge hit, 1 MB, every market on the page | **~60–80 ms, ~1.2 KB per market, only what you ask for**                   |
| Auth                  | public `_ak` key                                | **none — no key, no cookie, no login** (`readonly` in the path is literal) |
| FanDuel's own cadence | 30–60 s (10 s in play)                          | **5 s**                                                                    |

So the adapter runs both: the **page is the structure** (which games exist, teams, kickoffs, which markets are offered — re-read only when its cached copy can actually have changed), and the **price channel is the numbers**, read every 5 s in batches of 70. That is the same snapshot-plus-fast-channel split the DraftKings adapter has, and it makes the two books directly comparable.

- **Bound shown on the page: ≤ poll interval + request ≈ 5 s** (from ≈31 s before), matching the cadence FanDuel's own client uses. The latency panel shows the channel's status, batch count, p50 and how many price updates it has applied.
- Batch size is **70 because larger batches are silently truncated** — 96 ids came back as 80, which would have quietly frozen whatever fell off the end. Their client uses 70 for the same reason.
- The price channel is **layered on top, never load-bearing**: if it fails, the adapter serves the page's own prices, marks `prices.healthy = false`, widens the stated bound back to the CDN's and keeps going. The chaos run exercises exactly that (`FDprices=DOWN`).
- A line move can **re-key a selection**, and the new id only exists on the page — so an unrecognised selection id forces an early structure refresh rather than being silently dropped.
- The page channel keeps everything it had: `If-None-Match` (an unchanged page is a **304 in ~10 ms with no body**), and a cache-aware schedule that sleeps `max-age − Age` instead of hammering (`npm run probe:fanduel` prints the cycle: "0 new edge copies in 40 s; the scheduler would have made 2 requests instead of 40").
- **`FD_CACHE_BYPASS=true`** appends a unique query string so every _page_ read reaches FanDuel's origin. Measured: `X-Cache: Miss`, ~400 ms instead of ~45 ms — and in eight edge/origin pairs taken back to back, **the origin returned exactly the same ETag and prices as the edge copy every time**. It buys nothing on a settled board, which is why it is off by default; the price channel is the real answer to freshness and made it largely moot.
- The `Age` header never exceeded `max-age` in ~80 observed requests, so CloudFront is not serving inside its `stale-while-revalidate=60` window — which would have widened the page bound. Falsifiable on the page: the panel prints the age of the copy we hold.
- **`FD_PRICES_ENABLED=false`** turns the channel off and restores the page-only behaviour exactly, for comparison.

**What "who moved first" can and cannot say.** The tracker pairs the same move (same new line, or same direction) seen at both books within 120 s and reports the lead. DraftKings' time is their engine stamp; FanDuel's is when the price channel saw it, which trails their trader by at most one 5 s poll. A lead means the number was public at that book first; a lead shorter than ~5 s says nothing about which trader moved first. The panel says this in its own footnote.

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

**Moves.** Every price change from either book lands in "Recent moves" with its badge and source (`push` / `snapshot` / `poll`). "Who moved first?" pairs the same destination (same new line, or same direction of price change) at the two books within 120 s, counts leads per book and reports the median lead, in the browser off its own history and on the server from a 2-hour ring buffer (`/api/compare`). The caveat about FanDuel's poll interval is printed under it.

---

## Failure modes

| What breaks                                              | What the service does                                                                                                                                                                | What you see                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| A book unreachable at startup (403/5xx/timeout)          | Retries with jittered backoff (1 → 30 s); serves an empty state as `degraded` for that book                                                                                          | "Waiting for DraftKings/FanDuel… retrying" with the last error |
| DraftKings REST fails after startup                      | Keeps last-known-good; socket keeps running; `lastSnapshotAt` ages                                                                                                                   | Table intact; last error in the latency panel                  |
| DraftKings socket closes (`1000/1006/1013/4001/4002`)    | Reconnects with jittered backoff (1 s → 15 s cap), resubscribes, then resyncs to fill the gap                                                                                        | LIVE → RECONNECTING → LIVE                                     |
| DraftKings socket down > 15 s                            | POLLING every 3 s; keeps trying the socket in the background                                                                                                                         | Amber POLLING pill on the DK badge                             |
| DraftKings socket alive but silent                       | Ping every 15 s; forced reconnect after 45 s idle; 60 s resync catches anything missed (counted as drift)                                                                            | Nothing, unless it crosses the stale threshold                 |
| Delta references an unknown id                           | Counted (`unresolvedDeltas`), resync scheduled                                                                                                                                       | Nothing — the resync heals it                                  |
| FanDuel price channel fails                              | Falls back to the page's own prices, flags `prices.healthy = false` and widens the stated bound back to the CDN's; the book stays up                                                 | "unavailable" in the latency panel, bound back to ≤ 31 s       |
| FanDuel returns 5xx / times out / 429 with `Retry-After` | That feed alone goes `degraded`, keeps last-known-good, and keeps polling with a backoff (base × 2ⁿ, capped at 8 s, never sooner than `Retry-After`); DraftKings' state is untouched | Red DEGRADED pill on the FD badge; DK still LIVE               |
| FanDuel answers 304 for a long time                      | Normal: it is contact (never stale), no delta, `restNotModified` climbs                                                                                                              | "last → 304 not modified" in the panel                         |
| Payload has an unexpected shape                          | Lenient `zod` schemas with passthrough; bad entities dropped and counted, never thrown                                                                                               | A "—" in a cell at worst; `invalidEntities` in the panel       |
| A book changes the contract entirely                     | Validation fails → `degraded` with last-known-good, for that book                                                                                                                    | Red DEGRADED banner with the time of the last good data        |
| No contact with a book for 90 s                          | `meta.stale = true` for that book                                                                                                                                                    | Red STALE banner naming the book                               |
| Browser loses the stream                                 | `EventSource` auto-reconnect + `Last-Event-ID` replay (200-delta buffer across books), 35 s client watchdog                                                                          | "RECONNECTING to this server" pill                             |

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
| `FD_PRICE_INTERVAL_MS`                              | `5000`                              | Cadence of the uncached live price channel (`getMarketPrices`). FanDuel's own client uses 5 s  |
| `FD_PRICES_ENABLED`                                 | `true`                              | `false` reads prices from the cached page instead, restoring the ≈31 s bound                   |
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
npm test               # vitest, 119 tests, < 2 s
npm run chaos          # end-to-end resilience run against a mock DraftKings + mock FanDuel (~80 s, offline)
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
- `test/fanduel-prices.test.ts` — the live price channel: the POST shape and batching at 70 (the size their server truncates past), suspension from either the market or a runner, omitted/closed markets, `Retry-After`; overlaying prices onto the page structure, stamping only what moved, line moves, and a re-keyed selection forcing a structure refresh; and the adapter reading the page once for structure then pricing every poll, cloning so the store never gets the cached objects, and falling back to the page price when the channel fails.
- `test/compare.test.ts` — the team registry (every spelling both books use, ambiguity refused, 32 unique nicknames); game matching across spellings and a one-minute kickoff gap, single-book games, the same matchup a week apart, unresolved names; best price / edge / hold, no best across different lines, ties or suspended prices; move pairing (order, window, direction, same-book, unknown game, at-most-once).
- `test/store.test.ts` — snapshot diffing, `prev` history, delta resolution by id / replaced id / market+side, unresolved reporting, idempotency, suspension, removal, and snapshot/delta ordering (an older snapshot cannot overwrite a newer socket write).
- `test/feed.test.ts` — the state machine with a fake adapter and fake timers: bootstrap backoff, socket → polling fallback and recovery with gap-filling resync, latency attribution with skew, unresolved → resync, stale flag, refresh rate limit, drift counting; poll-only adapters: 304 as contact without a delta, the poll hint followed and clamped both ways, an outage as `degraded` with last-known-good and recovery, the failure backoff growing and resetting, and an upstream `Retry-After` being honoured.
- `test/ws.test.ts` — the socket client with a fake socket: subscribe payload, NTP-style skew from the ack, malformed frames, exponential backoff and reset, silence watchdog, clean stop.
- `test/sse.test.ts` — a snapshot per book on connect, one id sequence across books, heartbeats with every book's state, `Last-Event-ID` replay vs. fresh snapshots, dropping dead clients.
- `test/latency.test.ts` — skew correction math, continuous skew tracking across a clock step, and percentiles.
- `test/api.test.ts` — the HTTP routes in-process: the odds bundle and per-book snapshot, health per book, time, Refresh semantics (per-book results, 429 + `Retry-After` only when all refuse), the stream opening with a snapshot per book, diagnostics/metrics per book, `/api/compare` matching a game across books and calling who moved first, and a handler error becoming a 500 instead of a crash.
- `test/ui.test.tsx` — the React components rendered to HTML: every side/line/price in both odds formats, the dash for an unoffered market, the `SUSP` state, previous price + flash, day grouping and live score/period; the Compare table with both books per cell, the best price marked, differing lines flagged and a dash for a book that does not list the game; the lead tracker; the state pill for every feed condition per transport and the FanDuel freshness bound; the client reducer keeping books apart through snapshots, deltas, flashes, moves and heartbeats.

### Chaos run (end-to-end, no book involved)

`scripts/chaos.ts` starts a fake DraftKings snapshot API + socket and a fake FanDuel (its page API with `max-age`, `Age`, `ETag` and 304s like the real CDN, **plus its uncached price endpoint**) on localhost, points the **real built server** at them, and walks it through the failure modes the brief asks about, reporting what `/healthz` and `/api/odds` say at each step. CI runs it on every push. Output from the run that accompanied this README:

```
fixtures: DraftKings DET Lions ML = −325, FanDuel DET Lions ML = +205
1a boot: snapshots from both mocks                 DK=live          FD=polling         games=75/4  DET ML DK=-325  FD=205   FDprices=ok/0
1b DK socket pushed DET ML -> -300; FD polling     DK=live          FD=polling         games=75/4  DET ML DK=-300  FD=205   FDprices=ok/0
2a DK socket killed                                DK=reconnecting  FD=polling         games=75/4  DET ML DK=-300  FD=205   FDprices=ok/0    lastError(DK)=socket error: connect ECONNREFUSED
2b DK socket still down (> fallback window)        DK=polling       FD=polling         games=75/4  DET ML DK=-300  FD=205   FDprices=ok/0    lastError(DK)=socket error: connect ECONNREFUSED
3  DK snapshot API returns HTML                    DK=degraded      FD=polling         games=75/4  DET ML DK=-300  FD=205   FDprices=ok/0    lastError(DK)=socket error: connect ECONNREFUSED
4a DK snapshot API returns HTTP 500                DK=degraded/STALE FD=polling         games=75/4  DET ML DK=-300  FD=205   FDprices=ok/0    lastError(DK)=DraftKings HTTP 500 for http://127
4b ... 8 s with no DK contact at all               DK=degraded/STALE FD=polling         games=75/4  DET ML DK=-300  FD=205   FDprices=ok/0    lastError(DK)=socket error: connect ECONNREFUSED
5a DK snapshot API back, DET ML now -350           DK=polling       FD=polling         games=75/4  DET ML DK=-350  FD=205   FDprices=ok/0    lastError(DK)=socket error: connect ECONNREFUSED
5b FD moved DET ML +205 -> +220 behind its cache   DK=polling       FD=polling         games=75/4  DET ML DK=-350  FD=220   FDprices=ok/1    lastError(DK)=socket error: connect ECONNREFUSED
5c FD API returns HTTP 500 (DK untouched)          DK=polling       FD=degraded        games=75/4  DET ML DK=-350  FD=220   FDprices=DOWN/1  lastError(FD)=FanDuel HTTP 500 for http://127.0.
5d FD API back                                     DK=polling       FD=polling         games=75/4  DET ML DK=-350  FD=220   FDprices=ok/1    lastError(FD)=FanDuel HTTP 500 for http://127.0.
6  DK socket back (reconnect backoff capped at 15 s) DK=live          FD=polling         games=75/4  DET ML DK=-350  FD=220   FDprices=ok/1    lastError(FD)=FanDuel HTTP 500 for http://127.0.
```

The `FDprices` column is the live price channel — healthy, and how many price updates it has applied. Step 5b is a price change behind the mock's 2 s `max-age` picked up by the next poll; 5c/5d are a FanDuel outage that leaves DraftKings' column untouched. Recovery in 5a and 5d is not instantaneous on purpose: repeated failures back the polling off (base × 2ⁿ, capped at 8 s, and never sooner than an upstream `Retry-After`), so an erroring book is not hammered while it is down — still far inside the 90 s stale threshold.

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

Betstamp tracks dozens of books across several leagues. Two books in one league already showed where that gets expensive, and it is not the transport — that part is nearly free once the shape is known. It is these:

**Reconnaissance is the real per-book cost, and it is mechanisable.** The single biggest win in this project — FanDuel's uncached `getMarketPrices`, which took the freshness bound from ~31 s to ~5 s — came from reading a minified bundle and noticing `HighPriorityMarketPricing` next to `pollingConfig: { refreshTimeInMs: 5000 }`. That is exactly the kind of search an LLM does well and a person does slowly: fetch a book's bundles, find the API hosts, the auth scheme, the polling constants, and which endpoint the client uses when it actually cares about a price. The output is not code, it is a short brief a human then verifies against the live endpoint — which is how I used it here, and why the decision log records measurements rather than assertions.

**Adapter scaffolding from a captured payload.** `BookAdapter` is deliberately small (`fetchSnapshot`, optional `subscribe`, optional `pollStats`). Given one real capture, generating the zod schema, the normalizer and a first test file is largely mechanical; the fixtures in this repo are already the input that would drive it. What must stay human is the mapping decisions that are not inferable from one sample — that `handicap: 0` means "no line" on a moneyline, that `result.type` is more reliable than the runner's name, that a re-keyed selection means a line move.

**Schema-drift detection, which is where books break you quietly.** Every adapter already counts `invalidEntities` and validates leniently, so drift shows up as a number rather than an outage. At dozens of books that number wants watching automatically: a nightly diff of each book's payload shape against its fixture, opening a PR with the schema change and a failing test when a field moves. The trap this project hit is the instructive one — FanDuel silently truncates a 96-id batch to 80, with no error. Nothing about that is visible in a schema; it only appears if something asserts "I asked for 96 and got 96", which is now a test.

**Entity resolution is the part that does not scale by hand.** `shared/teams.ts` is 32 NFL teams with a few aliases, and it works because NFL nicknames are unique. That property fails across leagues (MLB and NFL both have Giants) and across books that use local-language or abbreviated names. The durable version is a canonical entity store with per-book alias tables, where a fuzzy matcher proposes and a human confirms — with the rule this project already follows: **never guess**. An unresolved name is surfaced as unresolved, because comparing two different games is worse than comparing none.

**Anomaly detection on the feeds themselves.** The counters here exist so a person can see health at a glance; at scale nobody is glancing. `priceChanges` per book per unit time is the signal worth alerting on — a book that silently stops moving looks identical to a quiet market until you compare it with its peers. The same applies to the drift counter (a snapshot finding changes the push feed never delivered) and to the freshness bound widening when a fast channel falls back.

**Where I would not use it.** Anything whose correctness is a claim about the outside world: the latency figures, the cache behaviour, whether an endpoint is really uncached. Those are measurements, and this project's numbers are all reproducible with a script in the repo (`npm run probe`, `probe:fanduel`, `latency`, `chaos`) precisely so the claims can be checked rather than believed.

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
      rest.ts          page client: structure (ETag / If-None-Match, Cache-Control, Age, Retry-After, cache bypass)
      prices.ts        live price channel: uncached getMarketPrices, batched at 70 (what their betslip polls)
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
