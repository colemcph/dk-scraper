import { describe, expect, it } from 'vitest';
import { retryAfterOf } from '../src/server/book.js';
import { FanDuelAdapter } from '../src/server/fanduel/adapter.js';
import { applyMarketPrices, normalizeFanDuelPage } from '../src/server/fanduel/normalize.js';
import { FD_PRICE_BATCH_SIZE, FdPricesClient } from '../src/server/fanduel/prices.js';
import { silentLogger } from '../src/server/logger.js';
import type { Game } from '../src/shared/types.js';
import { fixture } from './helpers.js';

/**
 * FanDuel's live price channel: `POST .../fixedodds/readonly/v1/getMarketPrices`, the endpoint
 * their own client polls once a selection is in the betslip. Uncached, so it is what makes the
 * FanDuel freshness bound the poll interval rather than the page's 30 s CDN max-age.
 */

const NFL = { id: 'nfl', name: 'NFL' };
const AT = '2026-09-17T22:00:00.000Z';
const LATER = '2026-09-17T22:00:05.000Z';
const TNF = '35599552'; // Detroit Lions @ Buffalo Bills
const ML = '801.168781244'; // its moneyline: DET selection 50193, BUF selection 50203

const priceMarket = (
  marketId: string,
  runners: Array<{
    selectionId: number;
    decimal: number;
    american: number;
    handicap?: number;
    status?: string;
  }>,
  extra: Record<string, unknown> = {},
) => ({
  marketId,
  marketStatus: 'OPEN',
  inplay: false,
  runnerDetails: runners.map((r) => ({
    selectionId: r.selectionId,
    handicap: r.handicap ?? 0,
    runnerStatus: r.status ?? 'ACTIVE',
    winRunnerOdds: {
      trueOdds: { decimalOdds: { decimalOdds: r.decimal } },
      americanDisplayOdds: { americanOdds: r.american, americanOddsInt: r.american },
    },
  })),
  ...extra,
});

function fakeFetch(handler: (body: { marketIds: string[] }, call: number) => Response) {
  const calls: Array<{
    url: string;
    body: { marketIds: string[] };
    headers: Record<string, string>;
  }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { marketIds: string[] };
    calls.push({
      url: String(input),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return handler(body, calls.length);
  }) as typeof fetch;
  return { impl, calls };
}

describe('FdPricesClient', () => {
  it('posts market ids the way FanDuel`s client does and normalizes both odds formats', async () => {
    const { impl, calls } = fakeFetch((body) =>
      Response.json(
        body.marketIds.map((id) =>
          priceMarket(id, [
            { selectionId: 50193, decimal: 3.05, american: 205 },
            { selectionId: 50203, decimal: 1.4, american: -250 },
          ]),
        ),
        { headers: { 'cache-control': 'no-cache' } },
      ),
    );
    const client = new FdPricesClient({ region: 'on', fetchImpl: impl });
    const res = await client.fetchPrices([ML]);

    expect(client.url).toBe(
      'https://smp.on.sportsbook.fanduel.ca/api/sports/fixedodds/readonly/v1/getMarketPrices',
    );
    expect(calls[0]!.body).toEqual({ marketIds: [ML] });
    expect(calls[0]!.headers).toMatchObject({
      'Content-Type': 'application/json',
      Origin: 'https://sportsbook.fanduel.ca',
    });
    const market = res.prices.get(ML)!;
    expect(market).toMatchObject({ marketId: ML, suspended: false, inPlay: false });
    expect(market.runners).toEqual([
      { selectionId: '50193', odds: { american: 205, decimal: 3.05 }, line: 0, suspended: false },
      { selectionId: '50203', odds: { american: -250, decimal: 1.4 }, line: 0, suspended: false },
    ]);
    expect(res.missing).toEqual([]);
    expect(res.batches).toBe(1);
    expect(res.invalidEntities).toBe(0);
  });

  it('batches at 70 — the size their client uses, because the server truncates larger ones', async () => {
    const ids = Array.from({ length: 96 }, (_, i) => `801.${i}`);
    const { impl, calls } = fakeFetch((body) =>
      Response.json(
        body.marketIds.map((id) =>
          priceMarket(id, [{ selectionId: 1, decimal: 2, american: 100 }]),
        ),
      ),
    );
    const res = await new FdPricesClient({ region: 'on', fetchImpl: impl }).fetchPrices(ids);
    expect(FD_PRICE_BATCH_SIZE).toBe(70);
    expect(calls.map((c) => c.body.marketIds.length)).toEqual([70, 26]);
    expect(res.batches).toBe(2);
    expect(res.prices.size).toBe(96); // nothing silently dropped off the end
  });

  it('reports markets the endpoint omits, drops closed ones, and counts malformed runners', async () => {
    const { impl } = fakeFetch(() =>
      Response.json([
        priceMarket('a', [{ selectionId: 1, decimal: 2, american: 100 }]),
        priceMarket('b', [{ selectionId: 2, decimal: 2, american: 100 }], {
          marketStatus: 'CLOSED',
        }),
        { marketId: 'c', marketStatus: 'OPEN', runnerDetails: [{ selectionId: 3 }] }, // no odds
      ]),
    );
    const res = await new FdPricesClient({ region: 'on', fetchImpl: impl }).fetchPrices([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect([...res.prices.keys()]).toEqual(['a', 'c']);
    expect(res.prices.get('c')!.runners).toEqual([]);
    expect(res.missing).toEqual(['b', 'd']);
    expect(res.invalidEntities).toBe(1);
  });

  it('marks suspension from either the market or a runner, and flags in-play', async () => {
    const { impl } = fakeFetch(() =>
      Response.json([
        priceMarket('susp-market', [{ selectionId: 1, decimal: 2, american: 100 }], {
          marketStatus: 'SUSPENDED',
          inplay: true,
        }),
        priceMarket('susp-runner', [
          { selectionId: 1, decimal: 2, american: 100, status: 'SUSPENDED' },
          { selectionId: 2, decimal: 2, american: 100 },
        ]),
      ]),
    );
    const res = await new FdPricesClient({ region: 'on', fetchImpl: impl }).fetchPrices([
      'susp-market',
      'susp-runner',
    ]);
    expect(res.prices.get('susp-market')).toMatchObject({ suspended: true, inPlay: true });
    expect(res.prices.get('susp-runner')!.suspended).toBe(true);
  });

  it('surfaces HTTP errors with Retry-After so the feed can back off', async () => {
    const { impl } = fakeFetch(
      () => new Response('nope', { status: 429, headers: { 'retry-after': '3' } }),
    );
    const err = await new FdPricesClient({ region: 'on', fetchImpl: impl })
      .fetchPrices(['a'])
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 3_000 });
    expect(retryAfterOf(err)).toBe(3_000);
  });
});

describe('applyMarketPrices', () => {
  const pageGames = (): Game[] => normalizeFanDuelPage(fixture('fd-page-nfl.json'), NFL, AT).games;

  it('overlays live prices onto the page structure and stamps only what moved', () => {
    const games = pageGames();
    const tnf = games.find((g) => g.id === TNF)!;
    expect(tnf.markets.moneyline!.sides.away!.odds.american).toBe(205); // from the page

    const prices = new Map([
      [
        ML,
        {
          marketId: ML,
          suspended: false,
          inPlay: false,
          runners: [
            {
              selectionId: '50193',
              odds: { american: 190, decimal: 2.9 },
              line: 0,
              suspended: false,
            },
            {
              selectionId: '50203',
              odds: { american: -250, decimal: 1.4 },
              line: 0,
              suspended: false,
            }, // unchanged
          ],
        },
      ],
    ]);
    const applied = applyMarketPrices(games, prices, LATER);

    const ml = tnf.markets.moneyline!;
    expect(ml.sides.away!.odds).toEqual({ american: 190, decimal: 2.9 });
    expect(ml.sides.away!.updatedAt).toBe(LATER); // moved: stamped with the live-channel time
    expect(ml.sides.home!.updatedAt).toBe(AT); // unchanged: keeps the page time
    expect(applied.updated).toBe(1);
    expect(applied.unmatched).toBe(0);
    // Only the moneyline was priced; the other markets of every game are reported as missing.
    expect(applied.missingMarkets).toBe(11);
  });

  it('applies a line move, suspension and in-play from the price channel', () => {
    const games = pageGames();
    const tnf = games.find((g) => g.id === TNF)!;
    const total = tnf.markets.total!;
    const over = total.sides.over!;
    const under = total.sides.under!;
    const prices = new Map([
      [
        total.sourceMarketId,
        {
          marketId: total.sourceMarketId,
          suspended: true,
          inPlay: true,
          runners: [
            {
              selectionId: over.sourceSelectionId.split(':')[1]!,
              odds: over.odds,
              line: 55.5,
              suspended: false,
            },
            {
              selectionId: under.sourceSelectionId.split(':')[1]!,
              odds: under.odds,
              line: 55.5,
              suspended: true,
            },
          ],
        },
      ],
    ]);
    applyMarketPrices(games, prices, LATER);
    expect(tnf.markets.total!.sides.over!.line).toBe(55.5);
    expect(tnf.markets.total!.sides.under!.line).toBe(55.5);
    expect(tnf.markets.total!.suspended).toBe(true);
    expect(tnf.status).toBe('live');
  });

  it('counts a re-keyed selection as unmatched so the caller re-reads the structure page', () => {
    const games = pageGames();
    const prices = new Map([
      [
        ML,
        {
          marketId: ML,
          suspended: false,
          inPlay: false,
          runners: [
            // FanDuel re-keyed the selection (what a line move looks like): we cannot place it.
            {
              selectionId: '999999',
              odds: { american: 190, decimal: 2.9 },
              line: 0,
              suspended: false,
            },
          ],
        },
      ],
    ]);
    const applied = applyMarketPrices(games, prices, LATER);
    expect(applied.updated).toBe(0);
    expect(applied.unmatched).toBe(1);
    expect(games.find((g) => g.id === TNF)!.markets.moneyline!.sides.away!.odds.american).toBe(205);
  });

  it('never applies a moneyline handicap as a line', () => {
    const games = pageGames();
    const prices = new Map([
      [
        ML,
        {
          marketId: ML,
          suspended: false,
          inPlay: false,
          runners: [
            {
              selectionId: '50193',
              odds: { american: 190, decimal: 2.9 },
              line: 0,
              suspended: false,
            },
          ],
        },
      ],
    ]);
    applyMarketPrices(games, prices, LATER);
    expect(games.find((g) => g.id === TNF)!.markets.moneyline!.sides.away!.line).toBeUndefined();
  });
});

describe('FanDuelAdapter with the live price channel', () => {
  const PAGE = JSON.stringify(fixture('fd-page-nfl.json'));
  const PAGE_HEADERS = {
    'content-type': 'application/json',
    'cache-control': 'public, max-age=30, stale-while-revalidate=60',
    etag: 'W/"abc"',
    age: '0',
    date: 'Thu, 17 Sep 2026 22:00:00 GMT',
    'x-cache': 'Miss from cloudfront',
  };

  /** Price responses that echo the fixture's real selection ids, so nothing looks re-keyed. */
  const fixtureMarkets = Object.values(
    fixture<{
      attachments: {
        markets: Record<
          string,
          { marketId: string; runners: Array<{ selectionId: number; handicap: number }> }
        >;
      };
    }>('fd-page-nfl.json').attachments.markets,
  );
  const pricesFor = (ids: string[]) =>
    ids.map((id) => {
      const runners = fixtureMarkets.find((m) => String(m.marketId) === id)?.runners ?? [];
      return priceMarket(
        id,
        runners.map((r) =>
          Number(r.selectionId) === 50193
            ? { selectionId: 50193, decimal: 2.9, american: 190, handicap: r.handicap } // DET moved
            : {
                selectionId: Number(r.selectionId),
                decimal: 1.91,
                american: -110,
                handicap: r.handicap,
              },
        ),
      );
    });

  /** Splits traffic: GETs are the structure page, POSTs are the price channel. */
  function split(priceHandler: (marketIds: string[], call: number) => Response) {
    let pageCalls = 0;
    let priceCalls = 0;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        priceCalls++;
        const body = JSON.parse(String(init?.body ?? '{}')) as { marketIds: string[] };
        return priceHandler(body.marketIds, priceCalls);
      }
      pageCalls++;
      return new Response(PAGE, { status: 200, headers: PAGE_HEADERS });
    }) as typeof fetch;
    return { impl, counts: () => ({ pageCalls, priceCalls }) };
  }

  const adapterWith = (impl: typeof fetch, over: Partial<Parameters<typeof makeOpts>[0]> = {}) =>
    new FanDuelAdapter(makeOpts({ impl, ...over }));
  const makeOpts = (o: {
    impl: typeof fetch;
    pricesEnabled?: boolean;
    priceIntervalMs?: number;
  }) => ({
    region: 'on',
    apiKey: 'KEY',
    timezone: 'America/Toronto',
    pollIntervalMs: 1_000,
    priceIntervalMs: o.priceIntervalMs ?? 5_000,
    ...(o.pricesEnabled === undefined ? {} : { pricesEnabled: o.pricesEnabled }),
    logger: silentLogger,
    rest: { fetchImpl: o.impl },
    prices: { fetchImpl: o.impl },
  });

  it('reads the page once for structure, then prices every poll at the price cadence', async () => {
    const { impl, counts } = split((ids) => Response.json(pricesFor(ids)));
    const adapter = adapterWith(impl);

    const first = await adapter.fetchSnapshot(NFL);
    expect(first.games).toHaveLength(4);
    expect(first.nextPollInMs).toBe(5_000); // the price cadence, not the page's cache window
    expect(counts()).toEqual({ pageCalls: 1, priceCalls: 1 });
    const stats = adapter.pollStats().prices!;
    expect(stats).toMatchObject({ intervalMs: 5_000, lastStatus: 200, healthy: true, batches: 1 });
    expect(stats.markets).toBe(12); // 4 games x 3 main markets

    // The page is inside its cache window, so a second poll only re-reads prices.
    const second = await adapter.fetchSnapshot(NFL);
    expect(counts()).toEqual({ pageCalls: 1, priceCalls: 2 });
    expect(second.games).toHaveLength(4);
    // The live price won, over the page's own 205.
    expect(
      second.games.find((g) => g.id === TNF)!.markets.moneyline!.sides.away!.odds.american,
    ).toBe(190);
  });

  it('hands the store fresh objects every time, never the cached page', async () => {
    const { impl } = split((ids) => Response.json(ids.map((id) => priceMarket(id, []))));
    const adapter = adapterWith(impl);
    const a = await adapter.fetchSnapshot(NFL);
    const b = await adapter.fetchSnapshot(NFL);
    const ga = a.games.find((g) => g.id === TNF)!;
    const gb = b.games.find((g) => g.id === TNF)!;
    expect(ga).not.toBe(gb);
    expect(ga.markets.moneyline).not.toBe(gb.markets.moneyline);
    ga.markets.moneyline!.sides.away!.odds.american = -1; // mutating one must not touch the other
    expect(gb.markets.moneyline!.sides.away!.odds.american).toBe(205);
  });

  it('falls back to the page price when the channel fails, and says so instead of throwing', async () => {
    const { impl, counts } = split((_ids, call) =>
      call === 1
        ? new Response('boom', { status: 503 })
        : Response.json([priceMarket(ML, [{ selectionId: 50193, decimal: 2.9, american: 190 }])]),
    );
    const adapter = adapterWith(impl);

    const degraded = await adapter.fetchSnapshot(NFL);
    expect(degraded.games).toHaveLength(4); // still a full picture
    expect(
      degraded.games.find((g) => g.id === TNF)!.markets.moneyline!.sides.away!.odds.american,
    ).toBe(205);
    expect(adapter.pollStats().prices).toMatchObject({ healthy: false, lastStatus: 503 });
    // While unhealthy the cadence falls back to the page's, so we stop hammering the price host.
    expect(degraded.nextPollInMs).toBeGreaterThan(5_000);

    const recovered = await adapter.fetchSnapshot(NFL);
    expect(
      recovered.games.find((g) => g.id === TNF)!.markets.moneyline!.sides.away!.odds.american,
    ).toBe(190);
    expect(adapter.pollStats().prices).toMatchObject({ healthy: true, lastStatus: 200 });
    expect(recovered.nextPollInMs).toBe(5_000);
    expect(counts().priceCalls).toBe(2);
  });

  it('re-reads the structure page early when the price channel names a selection it does not know', async () => {
    const { impl, counts } = split((ids) =>
      Response.json(
        ids.map((id) => priceMarket(id, [{ selectionId: 424242, decimal: 2.9, american: 190 }])),
      ),
    );
    const adapter = adapterWith(impl);
    await adapter.fetchSnapshot(NFL);
    expect(counts().pageCalls).toBe(1);
    await adapter.fetchSnapshot(NFL); // unmatched selections forced a structure refresh
    expect(counts().pageCalls).toBe(2);
    expect(adapter.pollStats().prices!.unmatched).toBeGreaterThan(0);
  });

  it('can be turned off, leaving the cache-aware page behaviour exactly as it was', async () => {
    const { impl, counts } = split(() => Response.json([]));
    const adapter = adapterWith(impl, { pricesEnabled: false });
    const res = await adapter.fetchSnapshot(NFL);
    expect(counts()).toEqual({ pageCalls: 1, priceCalls: 0 });
    expect(adapter.pollStats().prices).toBeNull();
    expect(res.nextPollInMs).toBeGreaterThan(29_000); // max-age 30 − age 0, minus the request itself
    expect(res.nextPollInMs).toBeLessThanOrEqual(30_000);
    expect(res.games.find((g) => g.id === TNF)!.markets.moneyline!.sides.away!.odds.american).toBe(
      205,
    );
  });
});
