import { z } from 'zod';

/**
 * Lenient schemas for FanDuel's `content-managed-page` payload (`attachments.events` and
 * `attachments.markets`, both keyed by id). Same philosophy as the DraftKings schemas: passthrough
 * everywhere, only the fields we read are typed, one malformed entity is dropped and counted.
 */

const stringish = z.union([z.string(), z.number()]).transform((v) => String(v));

export const FdOdds = z
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

export const FdRunner = z
  .object({
    selectionId: stringish,
    /** Spread points for this side (signed), the total, or 0 for a moneyline. */
    handicap: z.number().optional(),
    runnerName: z.string().optional(),
    /** "DET Lions" — the same style DraftKings uses for labels. */
    nameAbbr: z.string().optional(),
    /** { type: "HOME" | "AWAY" | "OVER" | "UNDER" } */
    result: z.object({ type: z.string().optional() }).passthrough().optional(),
    /** ACTIVE | SUSPENDED | REMOVED | ... */
    runnerStatus: z.string().optional(),
    winRunnerOdds: FdOdds.optional(),
  })
  .passthrough();

export const FdMarket = z
  .object({
    marketId: stringish,
    eventId: stringish.optional(),
    marketName: z.string().optional(),
    /** MONEY_LINE | MATCH_HANDICAP_(2-WAY) | TOTAL_POINTS_(OVER/UNDER) | ...dozens more */
    marketType: z.string().optional(),
    marketTime: z.string().optional(),
    /** OPEN | SUSPENDED | CLOSED */
    marketStatus: z.string().optional(),
    inPlay: z.boolean().optional(),
    runners: z.array(z.unknown()).default([]),
  })
  .passthrough();

export const FdEvent = z
  .object({
    eventId: stringish,
    /** "Detroit Lions @ Buffalo Bills" for games; futures have plain names. */
    name: z.string().optional(),
    openDate: z.string().optional(),
    competitionId: stringish.optional(),
    inPlay: z.boolean().optional(),
  })
  .passthrough();

/** GET /api/content-managed-page?page=CUSTOM&customPageId=nfl&… */
export const FdPage = z
  .object({
    attachments: z
      .object({
        events: z.record(z.unknown()).default({}),
        markets: z.record(z.unknown()).default({}),
      })
      .passthrough(),
  })
  .passthrough();

export type FdRunnerT = z.infer<typeof FdRunner>;
export type FdMarketT = z.infer<typeof FdMarket>;
export type FdEventT = z.infer<typeof FdEvent>;
export type FdPageT = z.infer<typeof FdPage>;
