import { z } from 'zod';
import { americanFromDecimal, decimalFromAmerican, roundDecimal } from '../../shared/odds.js';
import type { Odds } from '../../shared/types.js';
import { BROWSER_USER_AGENT, parseRetryAfter } from '../http.js';
import { FdHttpError } from './rest.js';

/**
 * FanDuel's live price channel — the one their own client uses once a selection is in the betslip.
 *
 *   POST https://smp.{region}.sportsbook.fanduel.ca/api/sports/fixedodds/readonly/v1/getMarketPrices
 *   { "marketIds": ["801.168781244", ...] }
 *
 * Why this matters: the coupon page (`rest.ts`) sits behind a 30 s CloudFront cache, so nothing
 * read from it can be fresher than that. This endpoint answers `Cache-Control: no-cache` in ~60 ms
 * and returns only the markets asked for (~1.2 KB each instead of a 1 MB page), so its freshness is
 * just our poll interval. It needs no key, no cookie and no auth — `readonly` in the path is
 * literal; the neighbouring betslip endpoints are the ones that require a login.
 *
 * It carries prices and nothing else: no event, team, market type or kickoff. So the page stays the
 * structure source and this fills in the numbers, which is the same snapshot-plus-fast-channel
 * shape the DraftKings adapter has.
 *
 * Batch size is 70, matching their client — the server quietly truncates larger batches (96 ids
 * came back as 80), which would silently freeze the prices of whatever fell off the end.
 */
export const FD_PRICE_BATCH_SIZE = 70;

const stringish = z.union([z.string(), z.number()]).transform((v) => String(v));

const FdPriceOdds = z
  .object({
    americanDisplayOdds: z.object({ americanOdds: z.number().optional() }).passthrough().optional(),
    trueOdds: z
      .object({
        decimalOdds: z.object({ decimalOdds: z.number().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const FdPriceRunner = z
  .object({
    selectionId: stringish,
    handicap: z.number().optional(),
    runnerStatus: z.string().optional(),
    winRunnerOdds: FdPriceOdds.optional(),
  })
  .passthrough();

export const FdMarketPrice = z
  .object({
    marketId: stringish,
    marketStatus: z.string().optional(),
    inplay: z.boolean().optional(),
    runnerDetails: z.array(z.unknown()).default([]),
  })
  .passthrough();

/** The endpoint returns a bare array of markets. */
export const FdPricesResponse = z.array(z.unknown());

export interface PricedRunner {
  selectionId: string;
  odds: Odds;
  line?: number;
  suspended: boolean;
}

export interface PricedMarket {
  marketId: string;
  suspended: boolean;
  inPlay: boolean;
  runners: PricedRunner[];
}

export interface FdPricesResult {
  /** marketId -> current prices */
  prices: Map<string, PricedMarket>;
  durationMs: number;
  fetchedAt: string;
  batches: number;
  /** Market ids we asked for that the endpoint did not return (closed, or unknown to it). */
  missing: string[];
  invalidEntities: number;
}

export interface FdPricesOptions {
  region: string;
  /** Override the origin (chaos tests). Default: https://smp.{region}.sportsbook.fanduel.ca */
  baseUrl?: string;
  origin?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function toOdds(raw: z.infer<typeof FdPriceOdds> | undefined): Odds | undefined {
  const decimalRaw = raw?.trueOdds?.decimalOdds?.decimalOdds;
  const americanRaw = raw?.americanDisplayOdds?.americanOdds;
  const decimal =
    typeof decimalRaw === 'number' && Number.isFinite(decimalRaw) && decimalRaw > 1
      ? decimalRaw
      : undefined;
  const american =
    typeof americanRaw === 'number' && Number.isInteger(americanRaw) && americanRaw !== 0
      ? americanRaw
      : undefined;
  if (decimal !== undefined) {
    return { american: american ?? americanFromDecimal(decimal), decimal: roundDecimal(decimal) };
  }
  if (american !== undefined) return { american, decimal: decimalFromAmerican(american) };
  return undefined;
}

export class FdPricesClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly origin: string;

  constructor(private readonly opts: FdPricesOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.baseUrl = opts.baseUrl ?? `https://smp.${opts.region}.sportsbook.fanduel.ca`;
    this.origin = opts.origin ?? 'https://sportsbook.fanduel.ca';
  }

  get url(): string {
    return `${this.baseUrl}/api/sports/fixedodds/readonly/v1/getMarketPrices`;
  }

  /** Fetches every id, in batches of FD_PRICE_BATCH_SIZE. Batches run in parallel. */
  async fetchPrices(marketIds: string[], signal?: AbortSignal): Promise<FdPricesResult> {
    const started = Date.now();
    const batches: string[][] = [];
    for (let i = 0; i < marketIds.length; i += FD_PRICE_BATCH_SIZE) {
      batches.push(marketIds.slice(i, i + FD_PRICE_BATCH_SIZE));
    }

    const prices = new Map<string, PricedMarket>();
    let invalidEntities = 0;
    const results = await Promise.all(batches.map((batch) => this.fetchBatch(batch, signal)));
    for (const raw of results) {
      for (const entry of raw) {
        const parsed = FdMarketPrice.safeParse(entry);
        if (!parsed.success) {
          invalidEntities++;
          continue;
        }
        const m = parsed.data;
        const status = (m.marketStatus ?? 'OPEN').toUpperCase();
        if (status !== 'OPEN' && status !== 'SUSPENDED') continue; // CLOSED: the page poll retires it
        const runners: PricedRunner[] = [];
        for (const rawRunner of m.runnerDetails) {
          const r = FdPriceRunner.safeParse(rawRunner);
          if (!r.success) {
            invalidEntities++;
            continue;
          }
          const runnerStatus = (r.data.runnerStatus ?? 'ACTIVE').toUpperCase();
          if (runnerStatus !== 'ACTIVE' && runnerStatus !== 'SUSPENDED') continue;
          const odds = toOdds(r.data.winRunnerOdds);
          if (!odds) {
            invalidEntities++;
            continue;
          }
          runners.push({
            selectionId: r.data.selectionId,
            odds,
            ...(typeof r.data.handicap === 'number' ? { line: r.data.handicap } : {}),
            suspended: runnerStatus === 'SUSPENDED',
          });
        }
        prices.set(m.marketId, {
          marketId: m.marketId,
          suspended: status === 'SUSPENDED' || runners.some((r) => r.suspended),
          inPlay: m.inplay === true,
          runners,
        });
      }
    }

    return {
      prices,
      durationMs: Date.now() - started,
      fetchedAt: new Date(started).toISOString(),
      batches: batches.length,
      missing: marketIds.filter((id) => !prices.has(id)),
      invalidEntities,
    };
  }

  private async fetchBatch(marketIds: string[], signal?: AbortSignal): Promise<unknown[]> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`timeout after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    const onOuterAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Language': 'en-CA,en;q=0.9',
          Origin: this.origin,
          Referer: `${this.origin}/`,
        },
        body: JSON.stringify({ marketIds }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new FdHttpError(
          res.status,
          this.url,
          text.replace(/\s+/g, ' ').slice(0, 160),
          parseRetryAfter(res.headers.get('retry-after')),
        );
      }
      const body: unknown = JSON.parse(text);
      const parsed = FdPricesResponse.safeParse(body);
      return parsed.success ? parsed.data : [];
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
