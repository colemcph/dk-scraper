import { describe, expect, it } from 'vitest';
import { retryAfterOf } from '../src/server/book.js';
import { FanDuelAdapter, nextPollDelayMs } from '../src/server/fanduel/adapter.js';
import { normalizeFanDuelPage, teamsOf, toOdds } from '../src/server/fanduel/normalize.js';
import { FdHttpError, FdRestClient } from '../src/server/fanduel/rest.js';
import { isCacheHit, parseAge, parseMaxAge, parseRetryAfter } from '../src/server/http.js';
import { silentLogger } from '../src/server/logger.js';
import { clone, fixture } from './helpers.js';

const NFL = { id: 'nfl', name: 'NFL' };
const AT = '2026-09-17T22:00:00.000Z';

interface FdPage {
  attachments: {
    events: Record<string, { eventId: number; name: string; openDate: string; inPlay?: boolean }>;
    markets: Record<
      string,
      {
        eventId: number;
        marketType: string;
        marketStatus: string;
        inPlay: boolean;
        runners: Array<Record<string, unknown>>;
      }
    >;
  };
}

/** Thursday night: Detroit Lions @ Buffalo Bills, the first game in the fixture. */
const TNF = '35599552';

describe('FanDuel page normalization (real capture, 4 games + a futures event)', () => {
  it('maps every game with its three main markets, canonical teams and both odds formats', () => {
    const { games, invalidEntities } = normalizeFanDuelPage(fixture('fd-page-nfl.json'), NFL, AT);
    expect(invalidEntities).toBe(0);
    expect(games).toHaveLength(4); // the "NFL Draft" futures event is not a game
    const g = games.find((x) => x.id === TNF)!;
    expect(g).toMatchObject({
      book: 'fanduel',
      league: 'nfl',
      startTime: '2026-09-18T00:15:00.000Z',
      status: 'upcoming',
      away: { id: 'DET', name: 'Detroit Lions', shortName: 'DET', color: '#0076B6' },
      home: { id: 'BUF', name: 'Buffalo Bills', shortName: 'BUF' },
      updatedAt: AT,
    });
    const ml = g.markets.moneyline!;
    expect(ml.suspended).toBe(false);
    expect(ml.sourceMarketId).toBe('801.168781244');
    expect(ml.sides.away).toMatchObject({
      label: 'DET Lions',
      odds: { american: 205, decimal: 3.05 },
      sourceSelectionId: '801.168781244:50193',
    });
    expect(ml.sides.away!.line).toBeUndefined();
    expect(ml.sides.home!.odds).toEqual({ american: -250, decimal: 1.4 });
    expect(g.markets.spread!.sides.away).toMatchObject({ line: 5.5, odds: { american: -110 } });
    expect(g.markets.spread!.sides.home).toMatchObject({ line: -5.5, odds: { american: -110 } });
    expect(g.markets.total!.sides.over).toMatchObject({
      label: 'Over',
      line: 54.5,
      odds: { american: -114, decimal: 1.877 },
    });
    expect(g.markets.total!.sides.under).toMatchObject({ label: 'Under', line: 54.5 });
    for (const game of games) {
      expect(
        game.markets.moneyline?.sides.home && game.markets.spread && game.markets.total,
      ).toBeTruthy();
    }
  });

  it('models suspension, drops closed markets, flags in-play games, and counts malformed runners', () => {
    const raw = clone(fixture<FdPage>('fd-page-nfl.json'));
    const markets = Object.values(raw.attachments.markets).filter((m) => String(m.eventId) === TNF);
    const ml = markets.find((m) => m.marketType === 'MONEY_LINE')!;
    const spread = markets.find((m) => m.marketType === 'MATCH_HANDICAP_(2-WAY)')!;
    const total = markets.find((m) => m.marketType === 'TOTAL_POINTS_(OVER/UNDER)')!;
    ml.marketStatus = 'SUSPENDED';
    spread.marketStatus = 'CLOSED';
    total.inPlay = true;
    total.runners[0]!.runnerStatus = 'SUSPENDED';
    delete total.runners[1]!.selectionId; // malformed
    const { games, invalidEntities } = normalizeFanDuelPage(raw, NFL, AT);
    const g = games.find((x) => x.id === TNF)!;
    expect(g.status).toBe('live');
    expect(g.markets.moneyline!.suspended).toBe(true);
    expect(g.markets.moneyline!.sides.home).toBeDefined(); // last price still shown
    expect(g.markets.spread).toBeNull();
    expect(g.markets.total!.suspended).toBe(true);
    expect(g.markets.total!.sides.under).toBeUndefined();
    expect(invalidEntities).toBe(1);
  });

  it('keeps unknown teams usable, ignores non-game events, and retires games with nothing left', () => {
    const raw = clone(fixture<FdPage>('fd-page-nfl.json'));
    raw.attachments.events[TNF]!.name = 'Toronto Argonauts @ Ottawa Redblacks';
    const past = Object.values(raw.attachments.events).find((e) => e.name.includes('Panthers'))!;
    past.openDate = '2026-09-10T17:00:00.000Z';
    for (const [id, m] of Object.entries(raw.attachments.markets)) {
      if (m.eventId === past.eventId) delete raw.attachments.markets[id];
    }
    const { games, invalidEntities } = normalizeFanDuelPage(raw, NFL, AT);
    expect(invalidEntities).toBe(0);
    const cfl = games.find((x) => x.id === TNF)!;
    expect(cfl.away).toEqual({ id: `${TNF}-away`, name: 'Toronto Argonauts', shortName: 'TORO' });
    expect(cfl.markets.moneyline!.sides.away).toBeDefined(); // resolved by result.type, not by name
    expect(games.find((x) => x.id === String(past.eventId))!.status).toBe('finished');
    expect(teamsOf('NFL Draft', '1')).toBeUndefined();
  });

  it('prefers decimal odds and derives the other format when one is missing', () => {
    expect(
      toOdds({
        selectionId: '1',
        winRunnerOdds: { trueOdds: { decimalOdds: { decimalOdds: 1.87719298245614 } } },
      }),
    ).toEqual({ american: -114, decimal: 1.877 });
    expect(
      toOdds({ selectionId: '1', winRunnerOdds: { americanDisplayOdds: { americanOdds: 205 } } }),
    ).toEqual({ american: 205, decimal: 3.05 });
    expect(toOdds({ selectionId: '1' })).toBeUndefined();
    expect(() => normalizeFanDuelPage({ nope: true }, NFL, AT)).toThrow();
  });
});

/* ------------------------------------------------------------------------------------------------
 * HTTP client: ETag, cache headers, errors
 * ---------------------------------------------------------------------------------------------- */

const PAGE = JSON.stringify(fixture('fd-page-nfl.json'));
const HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=30, stale-while-revalidate=60',
  etag: 'W/"f9d94-abc"',
  age: '12',
  date: 'Thu, 17 Sep 2026 22:00:00 GMT',
  'x-cache': 'Hit from cloudfront',
};

function fakeFetch(
  script: Array<(req: { url: string; headers: Record<string, string> }) => Response>,
) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const next = script.shift();
    if (!next) throw new Error('unexpected fetch');
    return next(call);
  }) as typeof fetch;
  return { impl, calls };
}

describe('FdRestClient', () => {
  const opts = { region: 'on', apiKey: 'KEY', timezone: 'America/Toronto' };

  it('asks for the page the way FanDuel`s client does and reads the cache headers back', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(PAGE, { status: 200, headers: HEADERS }),
    ]);
    const client = new FdRestClient({ ...opts, fetchImpl: impl });
    const res = await client.fetchPage('nfl');
    expect(calls[0]!.url).toBe(
      'https://sbapi.on.sportsbook.fanduel.ca/api/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=KEY&timezone=America%2FToronto',
    );
    expect(calls[0]!.headers).toMatchObject({
      Accept: 'application/json',
      Origin: 'https://sportsbook.fanduel.ca',
    });
    expect(calls[0]!.headers['If-None-Match']).toBeUndefined();
    expect(res).toMatchObject({
      status: 200,
      notModified: false,
      etag: 'W/"f9d94-abc"',
      ageMs: 12_000,
      maxAgeMs: 30_000,
      cacheHit: true,
      dateMs: Date.parse('Thu, 17 Sep 2026 22:00:00 GMT'),
    });
    expect((res.body as { attachments: unknown }).attachments).toBeDefined();
    expect(client.lastEtag).toBe('W/"f9d94-abc"');
  });

  it('sends If-None-Match on the next request and treats 304 as not modified', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(PAGE, { status: 200, headers: HEADERS }),
      () => new Response(null, { status: 304, headers: { ...HEADERS, age: '13' } }),
    ]);
    const client = new FdRestClient({ ...opts, fetchImpl: impl });
    await client.fetchPage('nfl');
    const res = await client.fetchPage('nfl');
    expect(calls[1]!.headers['If-None-Match']).toBe('W/"f9d94-abc"');
    expect(res).toMatchObject({ status: 304, notModified: true, ageMs: 13_000, maxAgeMs: 30_000 });
    expect(res.body).toBeUndefined();
  });

  it('bypasses the CDN with a unique query string when asked', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(PAGE, { status: 200, headers: HEADERS }),
    ]);
    await new FdRestClient({ ...opts, fetchImpl: impl, bypassCache: true }).fetchPage('nfl');
    expect(calls[0]!.url).toMatch(/&_=\d+$/);
  });

  it('surfaces HTTP errors with Retry-After, and non-JSON bodies as errors', async () => {
    const { impl } = fakeFetch([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
      () => new Response('<html>maintenance</html>', { status: 200 }),
    ]);
    const client = new FdRestClient({ ...opts, fetchImpl: impl });
    const err = await client.fetchPage('nfl').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FdHttpError);
    expect(err as FdHttpError).toMatchObject({ status: 429, retryAfterMs: 7_000 });
    // ...and that is the delay the feed reads off it (the adapter contract in book.ts).
    expect(retryAfterOf(err)).toBe(7_000);
    expect(retryAfterOf(new Error('boom'))).toBeNull();
    expect(retryAfterOf(undefined)).toBeNull();
    await expect(client.fetchPage('nfl')).rejects.toThrow(/non-JSON/);
  });
});

describe('cache header parsing', () => {
  it('reads max-age, age, retry-after and x-cache', () => {
    expect(parseMaxAge('public, max-age=30, stale-while-revalidate=60')).toBe(30_000);
    expect(parseMaxAge('no-store')).toBeNull();
    expect(parseMaxAge(null)).toBeNull();
    expect(parseAge('12')).toBe(12_000);
    expect(parseAge('')).toBeNull();
    expect(parseAge('x')).toBeNull();
    expect(parseRetryAfter('7')).toBe(7_000);
    const now = Date.parse('2026-09-17T22:00:00Z');
    expect(parseRetryAfter('Thu, 17 Sep 2026 22:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(isCacheHit('Hit from cloudfront')).toBe(true);
    expect(isCacheHit('RefreshHit from cloudfront')).toBe(true);
    expect(isCacheHit('Miss from cloudfront')).toBe(false);
    expect(isCacheHit(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------------
 * Adapter: cache-aware scheduling and stats
 * ---------------------------------------------------------------------------------------------- */

describe('FanDuelAdapter', () => {
  it('sleeps until the edge copy can change, then polls at the fast cadence', () => {
    expect(nextPollDelayMs({ ageMs: 12_000, maxAgeMs: 30_000 }, 1_000)).toBe(18_000);
    expect(nextPollDelayMs({ ageMs: 30_000, maxAgeMs: 30_000 }, 1_000)).toBe(1_000); // expired: fast
    expect(nextPollDelayMs({ ageMs: 45_000, maxAgeMs: 30_000 }, 1_000)).toBe(1_000); // stale-while-revalidate
    expect(nextPollDelayMs({ ageMs: null, maxAgeMs: 30_000 }, 1_000)).toBe(30_000); // a miss: fresh copy
    expect(nextPollDelayMs({ ageMs: 29_500, maxAgeMs: 30_000 }, 1_000)).toBe(1_000); // never below fast
    expect(nextPollDelayMs({ ageMs: null, maxAgeMs: null }, 1_000)).toBe(1_000); // no cache info
    expect(nextPollDelayMs({ ageMs: 0, maxAgeMs: 30_000 }, 1_000, true)).toBe(1_000); // bypass: plain cadence
  });

  it('returns a normalized snapshot with the hint, a 304 as notModified, and freshness stats', async () => {
    const { impl } = fakeFetch([
      // age 30: the edge copy is already at max-age, so the next poll re-reads it straight away.
      () => new Response(PAGE, { status: 200, headers: { ...HEADERS, age: '30' } }),
      () => new Response(null, { status: 304, headers: { ...HEADERS, age: '30' } }),
      () => new Response('nope', { status: 503, headers: { 'retry-after': '2' } }),
    ]);
    // Page-only: the live price channel has its own file (fanduel-prices.test.ts).
    const adapter = new FanDuelAdapter({
      region: 'on',
      apiKey: 'KEY',
      timezone: 'America/Toronto',
      pollIntervalMs: 0,
      priceIntervalMs: 5_000,
      pricesEnabled: false,
      logger: silentLogger,
      rest: { fetchImpl: impl },
    });
    expect(adapter.transport).toBe('poll');
    expect(adapter.site).toBe('on');

    const first = await adapter.fetchSnapshot(NFL);
    expect(first.games).toHaveLength(4);
    expect(first.notModified).toBeUndefined();
    expect(first.nextPollInMs).toBe(0); // already at max-age: nothing to wait for
    let stats = adapter.pollStats();
    expect(stats).toMatchObject({
      intervalMs: 0,
      bypassCache: false,
      cacheMaxAgeMs: 30_000,
      lastAgeMs: 30_000,
      lastCacheHit: true,
      lastStatus: 200,
      etag: 'W/"f9d94-abc"',
      generatedAt: '2026-09-17T21:59:30.000Z', // Date − Age
    });
    expect(stats.prices).toBeNull(); // this adapter runs page-only

    // A 304 with no live price channel means nothing can have moved: reported as unchanged.
    const second = await adapter.fetchSnapshot(NFL);
    expect(second).toMatchObject({ games: [], notModified: true });
    stats = adapter.pollStats();
    expect(stats.lastStatus).toBe(304);
    expect(stats.lastAgeMs).toBe(30_000);

    await expect(adapter.fetchSnapshot(NFL)).rejects.toMatchObject({
      status: 503,
      retryAfterMs: 2_000,
    });
    expect(adapter.pollStats().lastStatus).toBe(503);
  });
});
