# Decision log

Short, dated records of the choices that shaped this project and the evidence behind them.

## 2026-09-11 — Reconnaissance before code

**Decision:** spend the first evening finding out what DraftKings actually exposes before choosing a stack.

**What was done:** probed the JSON API from curl and Node; fetched the NFL page and grepped its bundles (`client.*.js`, `vendor.*.js`, `dkDataLayer.js`) for `wss://`, subscription builders and message formats; subscribed from Node and captured real frames on in-play games; checked every site key and socket region.

**Findings that drove everything else:**

- `sportsbook-nash.draftkings.com/api/sportscontent/{site}/v1/leagues/{id}` returns an already-relational `{events, markets, selections}` payload scoped to main lines, with `subscriptionPartials` telling you how to subscribe to the push feed. `cache-control: max-age=1`.
- The push feed is `wss://sportsbook-ws-{region}.draftkings.com/websocket`, JSON-RPC 2.0, deltas only, and it accepts `format=json` even though the site uses msgpack.
- Akamai fingerprints the TLS client: curl gets 403, Node 22's undici gets 200.
- A Canadian IP gets the Ontario product config; US site keys still work from Canada.
- No auth of any kind is required.

## 2026-09-12 — Data source: snapshot API + delta socket (not scraping, not a third-party API)

**Options:** REST polling only · REST + socket · headless browser · SSR HTML scraping · third-party odds API.

**Decision:** REST for bootstrap/resync/fallback, socket as the primary live channel.

**Why:** it is what DraftKings' own client does; sub-second latency with one upstream connection regardless of visitors; the REST channel doubles as a correctness check (drift counter). Headless scraping costs seconds and memory; a third-party API is minutes stale and demonstrates nothing.

## 2026-09-12 — Node 22 + TypeScript

**Decision:** Node, not Python.

**Why:** evidence, not preference — Node's HTTP/WS stack passes Akamai's fingerprint check as-is; Python's common clients would need impersonation libraries. One language for server, socket client and UI. Built-in `fetch` keeps the runtime dependency list short (`hono`, `@hono/node-server`, `ws`, `zod`, `react`, `react-dom`).

## 2026-09-12 — Ontario site key

**Decision:** default to `dkcaon` / `ca-on`.

**Why:** Betstamp is in Toronto and its users see DraftKings Ontario. Payloads were identical across site keys tonight, but mirroring the right product is the point; it's an env var either way.

## 2026-09-12 — SSE to the browser, one process, Render free tier

**Decision:** Server-Sent Events, single Node process serving API + static UI, Render web service with a Blueprint; Dockerfile for portability.

**Why:** the browser only ever receives; `EventSource` reconnects and resumes for free. A persistent process is required to hold the DraftKings socket, which rules out serverless/static hosts. Render is $0 and supports long-lived connections; the trade-off is idle sleep, mitigated with a pinger and documented.

## 2026-09-12 — Latency is measured against DraftKings' own timestamps, with clock-skew correction

**Decision:** report `createdTime → server` and `server → browser` separately, each corrected by an NTP-style offset (subscribe ack for DraftKings; `/api/time` for the browser), and show p50/p95 plus a per-move breakdown.

**Why:** my development PC's clock was 1.85 s behind DraftKings'. Without correction the numbers would be negative or meaningless. Being explicit about the method is more defensible than a single "fast" claim.

## 2026-09-12 — Store semantics: idempotent deltas, indices, resync on unknown ids

**Decision:** the store resolves selections by id → replaced id → market+side, treats value-equal updates as no-ops, and reports anything it cannot place so the manager resyncs.

**Why:** the delta feed omits `marketId` on changes and re-keys selections on line moves; a naive "apply the frame" would either crash or silently corrupt. Idempotency makes replay after reconnect safe.

## 2026-09-12 — Lenient validation

**Decision:** `zod` schemas with `passthrough()`, mostly-optional fields, per-entity `safeParse`; drop and count rather than throw.

**Why:** the brief's "returns something unexpected" case. A new field or one malformed entity must not take the page down; a wholesale contract change degrades to last-known-good with a visible banner.

## 2026-09-12 — Market suspension modelled separately from "no sides"

**Decision:** `Market.suspended` mirrors DraftKings' `isSuspended`; missing sides are just missing.

**Why:** captured frames showed `{id, isSuspended: true}` changes with prices still present. Conflating the two would either hide prices needlessly or miss real suspensions. The UI dims suspended prices and tags them `SUSP`.

## 2026-09-13 — Socket writes beat older snapshots; skew is tracked continuously

**Problem found in review:** a periodic resync is fetched at T and applied ~200 ms later; a socket delta in that window was being overwritten by the older snapshot (bogus flash, stale value until the next move). Separately, the clock-skew estimate was taken once per subscribe; the development PC's clock stepped 2 s between two runs, which would have corrupted displayed latency until the next reconnect.

**Decision:** the store records when the socket last wrote each position and refuses older snapshot values for it (counted as `staleSnapshotSkips`). The latency tracker keeps the subscribe-ack estimate as an anchor and refines skew from every frame's publish timestamp over a 10-minute window, exposing a self-check (negative network-leg samples) on the page.

**Also:** unresolved-id resyncs back off exponentially to 60 s so a stream of foreign ids can never become a poll loop, and the dev API no longer serves the raw `src/web` on :3000.
