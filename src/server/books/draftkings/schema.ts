import { z } from 'zod';

/**
 * Lenient schemas for the DraftKings "sportscontent" payloads (REST snapshot + socket deltas).
 * Everything is `.passthrough()` and mostly optional on purpose: an unexpected extra field must
 * never break ingestion, and a single malformed entity is dropped and counted rather than
 * failing the whole payload. Only the fields we actually read are typed.
 */

const stringish = z.union([z.string(), z.number()]).transform((v) => String(v));

export const DkParticipant = z
  .object({
    id: stringish.optional(),
    name: z.string().optional(),
    venueRole: z.string().optional(),
    sortOrder: z.number().optional(),
    metadata: z
      .object({
        shortName: z.string().optional(),
        teamColor: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const DkScorecard = z
  .object({
    mainScorecard: z
      .object({
        intervalName: z.string().optional(),
        firstTeamScore: stringish.optional(),
        secondTeamScore: stringish.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const DkEvent = z
  .object({
    id: stringish,
    name: z.string().optional(),
    startEventDate: z.string().optional(),
    status: z.string().optional(),
    leagueId: stringish.optional(),
    participants: z.array(DkParticipant).optional(),
    liveGameState: z
      .object({
        period: z.string().optional(),
        isClockRunning: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    eventScorecard: DkScorecard.optional(),
  })
  .passthrough();

export const DkMarket = z
  .object({
    id: stringish,
    eventId: stringish.optional(),
    name: z.string().optional(),
    subcategoryId: z.union([z.number(), z.string()]).optional(),
    main: z.boolean().optional(),
    isSuspended: z.boolean().optional(),
    marketType: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        betOfferTypeId: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const DkSelection = z
  .object({
    id: stringish,
    marketId: stringish.optional(),
    label: z.string().optional(),
    outcomeType: z.string().optional(),
    points: z.number().optional(),
    trueOdds: z.number().optional(),
    displayOdds: z
      .object({
        american: z.string().optional(),
        decimal: z.string().optional(),
      })
      .passthrough()
      .optional(),
    replacedSelectionId: stringish.optional(),
    participants: z.array(DkParticipant).optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export const DkSubscriptionPartial = z
  .object({
    entity: z.string(),
    query: z.string(),
    includeMarkets: z.string().optional(),
  })
  .passthrough();

/** REST: GET /api/sportscontent/{site}/v1/leagues/{leagueId} */
export const DkLeagueSnapshot = z
  .object({
    leagues: z
      .array(z.object({ id: stringish, name: z.string().optional() }).passthrough())
      .optional(),
    events: z.array(z.unknown()).default([]),
    markets: z.array(z.unknown()).default([]),
    selections: z.array(z.unknown()).default([]),
    subscriptionPartials: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** An id reference in a `remove` list: DraftKings may send bare ids or objects. */
export const DkIdRef = z.union([
  stringish,
  z
    .object({ id: stringish })
    .passthrough()
    .transform((o) => o.id),
]);

const entityLists = z
  .object({
    events: z.array(z.unknown()).optional(),
    markets: z.array(z.unknown()).optional(),
    selections: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Socket: `event: "update"` frame */
export const DkUpdateFrame = z
  .object({
    id: z.string().optional(),
    event: z.literal('update'),
    data: z
      .object({
        data: z
          .object({
            add: entityLists.optional(),
            change: entityLists.optional(),
            remove: entityLists.optional(),
          })
          .passthrough(),
        metadata: z
          .object({
            createdTime: z.string().optional(),
            receivedTime: z.string().optional(),
            publishedTime: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    websocketPublishTimestamp: z.string().optional(),
  })
  .passthrough();

/** Any socket frame: acks, updates, unsubscribes, errors. Specific shapes are checked by the caller. */
export const DkSocketFrame = z
  .object({
    id: z.string().optional(),
    event: z.string().optional(),
    websocketPublishTimestamp: z.string().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export type DkParticipantT = z.infer<typeof DkParticipant>;
export type DkEventT = z.infer<typeof DkEvent>;
export type DkMarketT = z.infer<typeof DkMarket>;
export type DkSelectionT = z.infer<typeof DkSelection>;
export type DkLeagueSnapshotT = z.infer<typeof DkLeagueSnapshot>;
export type DkUpdateFrameT = z.infer<typeof DkUpdateFrame>;
export type DkSubscriptionPartialT = z.infer<typeof DkSubscriptionPartial>;
