import type { Logger } from '../../logger.js';
import type {
  BookAdapter,
  LeagueRef,
  SnapshotResult,
  Subscription,
  SubscriptionHandlers,
} from '../types.js';
import { defaultSubscriptionSpec, normalizeSnapshot } from './normalize.js';
import { DkRestClient, type DkRestOptions } from './rest.js';
import { DkSubscriptionPartial } from './schema.js';
import { DkSocketClient, type SocketFactory } from './ws.js';

export interface DraftKingsAdapterOptions {
  site: string;
  wsRegion: string;
  logger: Logger;
  rest?: Partial<DkRestOptions>;
  socketFactory?: SocketFactory;
  wsUrl?: string;
}

/** Well-known DraftKings league ids + their "Game" (main lines) subcategory. */
export const DK_LEAGUES: Record<string, LeagueRef> = {
  NFL: { id: '88808', name: 'NFL', subcategoryId: '4518' },
  MLB: { id: '84240', name: 'MLB', subcategoryId: '4519' },
};

export class DraftKingsAdapter implements BookAdapter {
  readonly book = 'draftkings' as const;
  readonly site: string;
  private readonly rest: DkRestClient;
  private readonly logger: Logger;

  constructor(private readonly opts: DraftKingsAdapterOptions) {
    this.site = opts.site;
    this.logger = opts.logger.child('dk');
    this.rest = new DkRestClient({ site: opts.site, ...(opts.rest ?? {}) });
  }

  async fetchSnapshot(league: LeagueRef, signal?: AbortSignal): Promise<SnapshotResult> {
    const res = await this.rest.fetchLeague(league.id, signal);
    const normalized = normalizeSnapshot(res.body, league, res.fetchedAt);
    if (normalized.invalidEntities > 0) {
      this.logger.warn('snapshot contained entities we could not map', {
        invalid: normalized.invalidEntities,
      });
    }
    return {
      games: normalized.games,
      fetchedAt: res.fetchedAt,
      durationMs: res.durationMs,
      subscriptionSpec: normalized.subscriptionSpec,
      invalidEntities: normalized.invalidEntities,
    };
  }

  subscribe(league: LeagueRef, spec: unknown, handlers: SubscriptionHandlers): Subscription {
    const parsed = DkSubscriptionPartial.safeParse(spec);
    const client = new DkSocketClient({
      region: this.opts.wsRegion,
      site: this.site,
      league,
      spec: parsed.success ? parsed.data : defaultSubscriptionSpec(league),
      handlers,
      logger: this.logger.child('ws'),
      ...(this.opts.socketFactory ? { socketFactory: this.opts.socketFactory } : {}),
      ...(this.opts.wsUrl ? { urlOverride: this.opts.wsUrl } : {}),
    });
    client.start();
    return client;
  }
}
