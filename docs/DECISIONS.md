# Decision log

Short, dated records of the choices that shaped this project and the evidence behind them.

## 2026-09-11 — Reconnaissance before code

**Decision:** spend the first evening in DraftKings' network tab and JS bundles rather than picking a data source by assumption.

**Why:** the brief grades the _choice_ of data source and the ability to explain latency and protections. Findings that would have been invisible otherwise: the JSON-RPC socket protocol, `subscriptionPartials` in the snapshot, msgpack-by-default with a JSON option, U+2212 in `displayOdds`, the four timestamps on every frame.

**Evidence:** `STRATEGY.md` (the pre-build strategy doc), `scripts/probe.ts`, `fixtures/dk-socket-frames.json`.

## 2026-09-12 — Data source: snapshot API + delta socket (not scraping, not a third-party API)

**Decision:** use the two channels DraftKings' own client uses.

**Why:** sub-second latency, one upstream connection regardless of visitors, a REST oracle for correctness. Headless scraping would be seconds behind and brittle; a third-party odds API would defeat the exercise.

**Rejected:** polling only (≥ 1–2 s stale by design, and noisier for DraftKings), Playwright (kept as the documented escape hatch if Akamai starts blocking Node's TLS fingerprint).

## 2026-09-12 — Node 22 + TypeScript

**Decision:** one language for the server, socket client and UI; built-in `fetch`/`WebSocket`.

**Why:** measured: curl gets an Akamai 403, Node's undici gets 200 with the same headers. No `curl_cffi`-style impersonation dependency needed. Runtime deps are `hono`, `ws`, `zod`, `react`.

## 2026-09-12 — Ontario site key

**Decision:** `dkcaon` / `ca-on` by default.

**Why:** the team is in Toronto, a Canadian IP is served the Ontario product anyway, and the fixtures were captured from it. Every US site key is one env var away and verified to use the same schema.

## 2026-09-12 — SSE to the browser, one process, Render free tier

**Decision:** `EventSource` rather than a browser WebSocket; a single long-running Node service.

**Why:** server→browser is one-directional; EventSource reconnects and resumes (`Last-Event-ID`) with zero client code. Serverless hosts cannot hold the upstream socket. The free tier sleeps; a GitHub Actions ping keeps it warm.

## 2026-09-12 — Latency is measured against DraftKings' own timestamps, with clock-skew correction

**Decision:** report `createdTime → our receipt` corrected by an NTP-style skew estimate from the subscribe ack, and `emittedAt → browser receipt` corrected by a `/api/time` offset.

**Why:** "how old is the number on the screen" is otherwise unanswerable. DraftKings stamps every delta; the ack gives their server time with a known RTT. Without correction the numbers were off by the ~1–2 s clock skew of the development PC.

## 2026-09-12 — Store semantics: idempotent deltas, indices, resync on unknown ids

**Decision:** the store keeps selection-id and market-id indices, resolves `replacedSelectionId`, and reports unresolved ids so the feed can resync.

**Why:** real frames show changed selections without a market id and line moves as new ids. The alternative (re-fetch the snapshot on every delta) throws away the socket's latency advantage.

## 2026-09-12 — Lenient validation

**Decision:** `zod` schemas with `.passthrough()` and mostly-optional fields; one malformed entity is dropped and counted, never thrown.

**Why:** the brief's "returns something unexpected" case. A new field or one malformed entity must not take the page down; a wholesale contract change degrades to last-known-good with a visible banner.

## 2026-09-12 — Market suspension modelled separately from "no sides"

**Decision:** `Market.suspended` mirrors DraftKings' `isSuspended`; missing sides are just missing.

**Why:** captured frames showed `{id, isSuspended: true}` changes with prices still present. Conflating the two would either hide prices needlessly or miss real suspensions. The UI dims suspended prices and tags them `SUSP`.

## 2026-09-13 — Socket writes beat older snapshots; skew is tracked continuously

**Problem found in review:** a periodic resync is fetched at T and applied ~200 ms later; a socket delta in that window was being overwritten by the older snapshot (bogus flash, stale value until the next move). Separately, the clock-skew estimate was taken once per subscribe; the development PC's clock stepped 2 s between two runs, which would have corrupted displayed latency until the next reconnect.

**Decision:** the store records when the socket last wrote each position and refuses older snapshot values for it (counted as `staleSnapshotSkips`). The latency tracker keeps the subscribe-ack estimate as an anchor and refines skew from every frame's publish timestamp over a 10-minute window, exposing a self-check (negative network-leg samples) on the page.

**Also:** unresolved-id resyncs back off exponentially to 60 s so a stream of foreign ids can never become a poll loop, and the dev API no longer serves the raw `src/web` on :3000.

## 2026-09-17 — FanDuel: the page API is the only public channel, and a CDN cache is the real bound

**Question:** the ask was "FanDuel has no WebSocket; there should be a snapshot you can use." True, but it needed checking before designing around it.

**What reconnaissance found** (`sportsbook.fanduel.ca`, Ontario):

- The site is a CloudFront SPA. The odds page calls `GET https://sbapi.on.sportsbook.fanduel.ca/api/content-managed-page?page=CUSTOM&customPageId=nfl&_ak=<key>&timezone=…` — a 1 MB JSON with `attachments.events` and `attachments.markets` (142 markets, all 32 games' moneyline/spread/total plus futures). The `_ak` key is a constant in their bundle.
- Their bundle _does_ open a WebSocket, `wss://pir.{REGION}.sportsbook.fanduel.ca/graphql/realtime` — an AWS AppSync subscription (`OnUpdateMarketPrice`) with its own auth key. Its neighbours in the bundle are `PlaceBuyOrder` and `GetOrderCalculation`: it belongs to their prediction-market product, not to the sportsbook. So the premise holds: no push feed for sportsbook prices.
- No bot protection on the API: curl and Node both get 200, no cookies, no tokens. The US host (`api.sportsbook.fanduel.com`) answers 400 to a Canadian IP; `.ca` + region `on` works.
- The response carries `Cache-Control: public, max-age=30, stale-while-revalidate=60`, an `ETag`, `Age`, `X-Cache: Hit from cloudfront` and `Vary: Origin`. Forty requests at one per second showed `Age` climbing 1→30 and resetting, every one an edge hit in ~10 ms, `If-None-Match` answered with a 304. A cache-busting query string produced `Miss from cloudfront` in ~300 ms with the same ETag as the edge copy.
- Their own web client polls at 10 s (in play) / 30 s / 60 s intervals (`pollingInterval:g?3e4:1e4`, `refetchInterval:6e4` in the bundle). The payload carries no price timestamps at all.

**Decision:** treat FanDuel as a poll transport with a stated freshness _bound_ rather than a measured latency: the copy we hold can be up to `max-age` (30 s) old, and we see a new copy within one poll interval of it landing. The bound is shown on the page as such.

## 2026-09-17 — FanDuel polling policy: sleep through max-age, poll fast at the boundary, always with ETags

**Options weighed:**

| Policy                                                                           | Freshness bound | Cost to FanDuel per 30 s | Verdict                                   |
| -------------------------------------------------------------------------------- | --------------- | ------------------------ | ----------------------------------------- |
| Poll every 30 s (their own cadence)                                              | ≤ 60 s          | 1 edge request           | too slow for a comparison                 |
| Poll every 1 s, full body                                                        | ≤ 31 s          | 30 × 1 MB edge hits      | 29 of 30 are wasted                       |
| Poll every 1 s with `If-None-Match`                                              | ≤ 31 s          | 30 × ~200-byte 304s      | fine, but blind hammering                 |
| **Age-aware: sleep `max-age − Age`, then 1 s ETag polls until the ETag changes** | **≤ 31 s**      | **~2–3 tiny requests**   | **chosen (default)**                      |
| Cache bypass (`&_=<ts>`) every N s                                               | ≤ N s + ~300 ms | 30/N origin requests     | opt-in `FD_CACHE_BYPASS`; not the default |

**Why the default is the cache-aware one:** it is exactly as fresh as the 1 Hz hammer (the edge copy cannot change before its `Age` reaches `max-age`, so there is nothing to learn in between) at a tenth of the requests, and it stays inside the footprint of a single browser tab. The probe (`npm run probe:fanduel`) prints the comparison: "0 new edge copies in 40 s; the scheduler would have made 2 requests instead of 40".

**Why bypass is available but off:** it is the only way past the 30 s bound and it works (measured: origin miss in ~300 ms), but every poll then costs FanDuel an origin request instead of an edge hit, from a service that runs unattended around the clock. Whether the origin copy is actually ahead of the edge copy could only be shown while prices are moving; the probe's step 5 measures it, and the flag is one env var for the interview demo. A polite middle ground for later: FanDuel's per-event page is cached for 15 s, so in-play games could be polled at twice the freshness without touching the origin.

**Also:** the poll loop became a `setTimeout` chain so an adapter can hand back a delay per response; a 304 counts as contact (so FanDuel is never wrongly flagged stale) but emits no delta; `Retry-After` on 429/503 is parsed and surfaced.

## 2026-09-17 — Cross-book entity resolution: a canonical NFL registry, matched by nickname, never guessed

**Problem:** DraftKings says "DET Lions", "LA Chargers", "NY Jets"; FanDuel says "Detroit Lions", "Los Angeles Chargers", "New York Jets"; kickoffs differ by a minute (FanDuel lists 17:01 for a 17:00 game).

**Decision:** a 32-team registry (`src/shared/teams.ts`) with ids, cities, nicknames, colours and the odd aliases ("Bucs", "Washington Football Team"). Every NFL nickname is unique, so a name resolves by its tail ("det lions" → Lions → DET); anything that does not resolve stays unresolved rather than being guessed, and the pair is flagged. Games pair on `${away}@${home}` canonical ids within a 24 h kickoff window, at most one game per book per pair.

**Why not a fuzzy matcher:** a wrong pair would compare two different games' prices, which is worse than no comparison. The registry is NFL-only on purpose (MLB has a "Giants" too); a second league needs its own table, and that is the point where the tooling in "Where AI would help" earns its keep.

**Comparison semantics:** a "best price" is only called when the books quote the same line (a −3.5 at −110 is not comparable to a −4 at +100); ties and suspended prices are excluded; each book's hold is shown. "Who moved first" pairs the same destination (same new line, or same direction of price change) at two books within 120 s — with the caveat, printed on the page, that FanDuel's time is when we saw it behind a 30 s cache.

## 2026-09-17 — One FeedManager per book, one SSE stream, a hub-wide sequence

**Decision:** each book gets its own adapter, store and `FeedManager`; a single `SseHub` multiplexes them (`snapshot` per book on connect, every event carries `meta.book`) and stamps events with its own sequence rather than the per-book store version.

**Why:** the state machines are independent — a FanDuel outage must not touch DraftKings' LIVE state (the chaos run shows exactly that) — and the browser wants one connection. Store versions collide across books, so `Last-Event-ID` replay needs a sequence that spans them. `/api/odds` became a bundle keyed by book; `/api/odds/:book` keeps the single-book shape.
