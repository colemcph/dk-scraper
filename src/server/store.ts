import type {
  Game,
  Market,
  MarketType,
  OddsChange,
  Side,
  SideKey,
  UpdateLatency,
} from '../shared/types.js';
import type { NormalizedDelta } from './book.js';

const MARKET_TYPES: readonly MarketType[] = ['moneyline', 'spread', 'total'];
const SIDE_KEYS: readonly SideKey[] = ['away', 'home', 'over', 'under'];

interface SelectionRef {
  gameId: string;
  market: MarketType;
  side: SideKey;
}

interface MarketRef {
  gameId: string;
  market: MarketType;
}

export interface ChangeSet {
  at: string;
  changes: OddsChange[];
  touchedGameIds: string[];
  removedGameIds: string[];
  /** Anything at all changed (touched or removed)? */
  changed: boolean;
  /** Snapshot fields ignored because the socket had delivered something newer meanwhile. */
  skippedStale: number;
}

export interface DeltaResult extends ChangeSet {
  /** Upstream ids we could not place — the caller should resync from a snapshot. */
  unresolved: string[];
}

/** How long we remember that the socket touched a position, for snapshot/delta ordering. */
const SEEN_TTL_MS = 10 * 60_000;
/** An NFL game is over well within this; guards against unrecognised "finished" status strings. */
const MAX_GAME_AGE_MS = 6 * 60 * 60_000;

function sameSide(a: Side, b: Side): boolean {
  return (
    a.line === b.line && a.odds.decimal === b.odds.decimal && a.odds.american === b.odds.american
  );
}

function sameTeam(a: Game['home'], b: Game['home']): boolean {
  return a.id === b.id && a.name === b.name && a.shortName === b.shortName && a.color === b.color;
}

function sameLive(a: Game['live'], b: Game['live']): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.period === b.period &&
    a.homeScore === b.homeScore &&
    a.awayScore === b.awayScore &&
    a.clockRunning === b.clockRunning
  );
}

function makeChange(
  ref: SelectionRef,
  prev: Side,
  next: Side,
  at: string,
  source: OddsChange['source'],
  latency?: UpdateLatency,
): OddsChange {
  return {
    gameId: ref.gameId,
    market: ref.market,
    side: ref.side,
    field: prev.line !== next.line ? 'line' : 'odds',
    ...(prev.line !== undefined ? { prevLine: prev.line } : {}),
    ...(next.line !== undefined ? { nextLine: next.line } : {}),
    prevOdds: prev.odds,
    nextOdds: next.odds,
    at,
    source,
    ...(latency ? { latency } : {}),
  };
}

const gameKey = (gameId: string) => `game:${gameId}`;
const marketKey = (gameId: string, market: MarketType) => `mkt:${gameId}:${market}`;
const sideKey = (gameId: string, market: MarketType, side: SideKey) =>
  `sel:${gameId}:${market}:${side}`;

/**
 * Authoritative in-memory state for one book + league.
 *
 * Two write paths, same output (a ChangeSet the SSE layer broadcasts):
 *  - `applySnapshot` replaces everything but diffs against the previous state so a resync
 *    still produces "line moved" events and keeps `prev` history for unchanged sides.
 *  - `applyDelta` applies a push-feed delta. DraftKings' deltas reference selections by id
 *    only (no market id on a change) and re-key a selection when its line moves
 *    (`replacedSelectionId`), so the store keeps id → position indices.
 *
 * Ordering: a snapshot is fetched at T and applied a little later. Any position the socket
 * touched after T is newer than the snapshot, so the snapshot must not overwrite it — the
 * store records when the socket last touched each game/market/side (our clock) and
 * `applySnapshot` skips those. Without this, a resync during a busy live game would flash a
 * bogus "change" back to an older price and leave it there until the selection moved again.
 */
export class OddsStore {
  private games = new Map<string, Game>();
  private selectionIndex = new Map<string, SelectionRef>();
  private marketIndex = new Map<string, MarketRef>();
  /** position key → ms (our clock) when the socket last wrote it */
  private socketSeenAt = new Map<string, number>();
  private versionCounter = 0;

  constructor(private readonly leagueId: string) {}

  get version(): number {
    return this.versionCounter;
  }

  get size(): number {
    return this.games.size;
  }

  getGame(id: string): Game | undefined {
    return this.games.get(id);
  }

  /**
   * Games worth showing, kickoff order. Finished games are kept internally until the next
   * snapshot drops them. A game that kicked off more than MAX_GAME_AGE_MS ago is hidden even if
   * DraftKings' status string was one we don't recognise (unknown strings map to "upcoming").
   */
  list(now = Date.now()): Game[] {
    return [...this.games.values()]
      .filter((g) => g.status !== 'finished' && now - Date.parse(g.startTime) < MAX_GAME_AGE_MS)
      .sort(
        (a, b) =>
          a.startTime.localeCompare(b.startTime) ||
          a.away.shortName.localeCompare(b.away.shortName),
      );
  }

  /**
   * @param at ISO time the snapshot request was *started* (our clock); socket writes after it win.
   */
  applySnapshot(incoming: Game[], at: string): ChangeSet {
    const fetchedAt = Date.parse(at);
    const newerOnSocket = (key: string) => (this.socketSeenAt.get(key) ?? 0) > fetchedAt;
    this.pruneSeen(fetchedAt);

    const changes: OddsChange[] = [];
    const touched = new Set<string>();
    const next = new Map<string, Game>();
    let skippedStale = 0;

    for (const ng of incoming) {
      const old = this.games.get(ng.id);
      if (!old) {
        next.set(ng.id, { ...ng, updatedAt: at });
        touched.add(ng.id);
        continue;
      }

      const merged: Game = { ...ng, markets: { moneyline: null, spread: null, total: null } };
      let gameTouched: boolean;
      if (newerOnSocket(gameKey(ng.id))) {
        // Socket patched status/score/kickoff after this snapshot was taken: keep ours.
        skippedStale++;
        merged.status = old.status;
        merged.startTime = old.startTime;
        merged.home = old.home;
        merged.away = old.away;
        if (old.live) merged.live = old.live;
        else delete merged.live;
        gameTouched = false;
      } else {
        gameTouched =
          old.status !== ng.status ||
          old.startTime !== ng.startTime ||
          !sameLive(old.live, ng.live) ||
          !sameTeam(old.home, ng.home) ||
          !sameTeam(old.away, ng.away);
      }

      for (const type of MARKET_TYPES) {
        const nm = ng.markets[type];
        const om = old.markets[type];
        const marketNewer = newerOnSocket(marketKey(ng.id, type));
        if (!nm) {
          if (om && marketNewer) {
            merged.markets[type] = om; // socket (re)created it after the snapshot; keep
            skippedStale++;
          } else if (om) gameTouched = true;
          continue;
        }
        if (!om) {
          if (marketNewer) {
            skippedStale++; // socket removed it after the snapshot; keep it gone
            continue;
          }
          merged.markets[type] = nm;
          gameTouched = true;
          continue;
        }

        let marketTouched = false;
        const mm: Market = { ...nm, sides: {}, updatedAt: om.updatedAt };
        if (marketNewer) {
          mm.suspended = om.suspended;
          mm.sourceMarketId = om.sourceMarketId;
          skippedStale++;
        } else if (om.suspended !== nm.suspended) {
          marketTouched = true;
        }

        for (const key of SIDE_KEYS) {
          const ns = nm.sides[key];
          const os = om.sides[key];
          if (newerOnSocket(sideKey(ng.id, type, key))) {
            if (os) mm.sides[key] = os; // socket wrote this side after the snapshot; keep ours
            skippedStale++;
            continue;
          }
          if (!ns) {
            if (os) marketTouched = true;
            continue;
          }
          if (!os) {
            mm.sides[key] = ns;
            marketTouched = true;
            continue;
          }
          if (sameSide(os, ns)) {
            mm.sides[key] = {
              ...ns,
              updatedAt: os.updatedAt,
              ...(os.prev ? { prev: os.prev } : {}),
            };
            continue;
          }
          const ref: SelectionRef = { gameId: ng.id, market: type, side: key };
          changes.push(makeChange(ref, os, ns, at, 'snapshot'));
          mm.sides[key] = {
            ...ns,
            updatedAt: at,
            prev: {
              ...(os.line !== undefined ? { line: os.line } : {}),
              odds: os.odds,
              changedAt: at,
            },
          };
          marketTouched = true;
        }
        if (marketTouched) {
          mm.updatedAt = at;
          gameTouched = true;
        }
        merged.markets[type] = mm;
      }

      merged.updatedAt = gameTouched ? at : old.updatedAt;
      if (gameTouched) touched.add(ng.id);
      next.set(ng.id, merged);
    }

    const removed: string[] = [];
    for (const [id, old] of this.games) {
      if (next.has(id)) continue;
      if (newerOnSocket(gameKey(id))) {
        next.set(id, old); // added/updated by the socket after the snapshot was taken
        skippedStale++;
      } else removed.push(id);
    }
    this.games = next;
    this.rebuildIndexes();

    const changed = touched.size > 0 || removed.length > 0;
    if (changed) this.versionCounter++;
    return {
      at,
      changes,
      touchedGameIds: [...touched],
      removedGameIds: removed,
      changed,
      skippedStale,
    };
  }

  applyDelta(delta: NormalizedDelta, latency?: UpdateLatency): DeltaResult {
    const at = delta.createdAt;
    const seenAt = Date.parse(delta.receivedAt) || Date.now();
    const seen = (key: string) => this.socketSeenAt.set(key, seenAt);
    const changes: OddsChange[] = [];
    const touched = new Set<string>();
    const removed: string[] = [];
    const unresolved: string[] = [];

    // 1. Removals first so a remove+add of the same id in one frame nets out correctly.
    for (const id of delta.selections.remove) {
      const ref = this.selectionIndex.get(id);
      if (!ref) continue;
      const market = this.games.get(ref.gameId)?.markets[ref.market];
      if (market) {
        delete market.sides[ref.side];
        market.updatedAt = at;
      }
      this.selectionIndex.delete(id);
      seen(sideKey(ref.gameId, ref.market, ref.side));
      touched.add(ref.gameId);
    }
    for (const id of delta.markets.remove) {
      const ref = this.marketIndex.get(id);
      if (!ref) continue;
      this.dropMarket(ref.gameId, ref.market);
      seen(marketKey(ref.gameId, ref.market));
      touched.add(ref.gameId);
    }
    for (const id of delta.games.remove) {
      if (!this.games.has(id)) continue;
      for (const type of MARKET_TYPES) this.dropMarket(id, type);
      this.games.delete(id);
      seen(gameKey(id));
      removed.push(id);
      touched.delete(id);
    }

    // 2. New games (markets arrive separately).
    for (const up of delta.games.upsert) {
      const existing = this.games.get(up.id);
      seen(gameKey(up.id));
      if (existing) {
        if (this.patchGame(existing, up, at)) touched.add(up.id);
        continue;
      }
      this.games.set(up.id, {
        ...up,
        book: 'draftkings',
        league: this.leagueId,
        markets: { moneyline: null, spread: null, total: null },
        updatedAt: at,
      });
      touched.add(up.id);
    }

    // 3. Partial game updates (status / kickoff / live score).
    for (const patch of delta.games.patch) {
      const game = this.games.get(patch.id);
      if (!game) {
        unresolved.push(`event:${patch.id}`);
        continue;
      }
      seen(gameKey(patch.id));
      if (this.patchGame(game, patch, at)) touched.add(patch.id);
    }

    // 4. Markets.
    for (const m of delta.markets.upsert) {
      const game = this.games.get(m.gameId);
      if (!game) {
        unresolved.push(`market:${m.sourceMarketId}`);
        continue;
      }
      seen(marketKey(game.id, m.type));
      const current = game.markets[m.type];
      if (current?.sourceMarketId === m.sourceMarketId) {
        if (m.suspended !== undefined && current.suspended !== m.suspended) {
          current.suspended = m.suspended;
          current.updatedAt = at;
          touched.add(game.id);
        }
        continue;
      }
      if (current) this.dropMarket(game.id, m.type);
      game.markets[m.type] = {
        type: m.type,
        sides: {},
        suspended: m.suspended ?? false,
        updatedAt: at,
        sourceMarketId: m.sourceMarketId,
      };
      this.marketIndex.set(m.sourceMarketId, { gameId: game.id, market: m.type });
      touched.add(game.id);
    }
    for (const p of delta.markets.patch) {
      const ref = this.marketIndex.get(p.sourceMarketId);
      const market = ref ? this.games.get(ref.gameId)?.markets[ref.market] : undefined;
      if (!ref || !market) continue; // a market we don't track (not an error)
      seen(marketKey(ref.gameId, ref.market));
      if (p.suspended !== undefined && market.suspended !== p.suspended) {
        market.suspended = p.suspended;
        market.updatedAt = at;
        touched.add(ref.gameId);
      }
    }

    // 5. Selections: resolve by own id, then by the id it replaced, then by market + side.
    for (const s of delta.selections.upsert) {
      let ref = this.selectionIndex.get(s.sourceSelectionId);
      if (!ref && s.replacedSelectionId) {
        ref = this.selectionIndex.get(s.replacedSelectionId);
        if (ref) this.selectionIndex.delete(s.replacedSelectionId);
      }
      if (!ref && s.sourceMarketId && s.key) {
        const mref = this.marketIndex.get(s.sourceMarketId);
        if (mref) ref = { gameId: mref.gameId, market: mref.market, side: s.key };
      }
      const game = ref ? this.games.get(ref.gameId) : undefined;
      const market = ref && game ? game.markets[ref.market] : undefined;
      if (!ref || !game || !market) {
        unresolved.push(`selection:${s.sourceSelectionId}`);
        continue;
      }
      seen(sideKey(ref.gameId, ref.market, ref.side));

      const existing = market.sides[ref.side];
      const line = s.line !== undefined ? s.line : existing?.line;
      const next: Side = {
        key: ref.side,
        label: s.label ?? existing?.label ?? ref.side,
        ...(line !== undefined ? { line } : {}),
        odds: s.odds,
        updatedAt: existing?.updatedAt ?? at,
        sourceSelectionId: s.sourceSelectionId,
      };

      if (existing) {
        if (existing.sourceSelectionId !== s.sourceSelectionId) {
          this.selectionIndex.delete(existing.sourceSelectionId);
        }
        if (sameSide(existing, next)) {
          if (existing.prev) next.prev = existing.prev;
        } else {
          changes.push(makeChange(ref, existing, next, at, 'socket', latency));
          next.updatedAt = at;
          next.prev = {
            ...(existing.line !== undefined ? { line: existing.line } : {}),
            odds: existing.odds,
            changedAt: at,
          };
          market.updatedAt = at;
          touched.add(game.id);
        }
      } else {
        next.updatedAt = at;
        market.updatedAt = at;
        touched.add(game.id);
      }
      market.sides[ref.side] = next;
      this.selectionIndex.set(s.sourceSelectionId, ref);
    }

    for (const id of touched) {
      const game = this.games.get(id);
      if (game) game.updatedAt = at;
    }
    const changed = touched.size > 0 || removed.length > 0;
    if (changed) this.versionCounter++;
    return {
      at,
      changes,
      touchedGameIds: [...touched],
      removedGameIds: removed,
      changed,
      skippedStale: 0,
      unresolved,
    };
  }

  /* ---------------------------------------------------------------------------------------- */

  private patchGame(
    game: Game,
    patch: {
      status?: Game['status'];
      startTime?: string;
      live?: Game['live'];
      home?: Game['home'];
      away?: Game['away'];
    },
    at: string,
  ): boolean {
    let touched = false;
    if (patch.status !== undefined && patch.status !== game.status) {
      game.status = patch.status;
      touched = true;
    }
    if (patch.startTime !== undefined && patch.startTime !== game.startTime) {
      game.startTime = patch.startTime;
      touched = true;
    }
    if (patch.live !== undefined && !sameLive(game.live, patch.live)) {
      game.live = patch.live;
      touched = true;
    }
    if (patch.home && !sameTeam(game.home, patch.home)) {
      game.home = patch.home;
      touched = true;
    }
    if (patch.away && !sameTeam(game.away, patch.away)) {
      game.away = patch.away;
      touched = true;
    }
    if (touched) game.updatedAt = at;
    return touched;
  }

  private dropMarket(gameId: string, type: MarketType): void {
    const game = this.games.get(gameId);
    const market = game?.markets[type];
    if (!game || !market) return;
    for (const side of Object.values(market.sides))
      this.selectionIndex.delete(side.sourceSelectionId);
    this.marketIndex.delete(market.sourceMarketId);
    game.markets[type] = null;
  }

  private pruneSeen(now: number): void {
    for (const [key, t] of this.socketSeenAt) {
      if (now - t > SEEN_TTL_MS) this.socketSeenAt.delete(key);
    }
  }

  private rebuildIndexes(): void {
    this.selectionIndex.clear();
    this.marketIndex.clear();
    for (const game of this.games.values()) {
      for (const type of MARKET_TYPES) {
        const market = game.markets[type];
        if (!market) continue;
        this.marketIndex.set(market.sourceMarketId, { gameId: game.id, market: type });
        for (const side of Object.values(market.sides)) {
          this.selectionIndex.set(side.sourceSelectionId, {
            gameId: game.id,
            market: type,
            side: side.key,
          });
        }
      }
    }
  }
}
