import type { BookMove } from '../shared/compare.js';
import type { FeedManager } from './feed.js';

/**
 * Recent price changes across every book, for `/api/compare`'s "who moved first" analysis.
 * A bounded ring buffer: the SSE replay buffer already covers reconnecting browsers, this exists
 * so the comparison can be asked server-side (curl, tests, the interview demo) too.
 */
export class MoveLog {
  private moves: BookMove[] = [];
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly feeds: FeedManager[],
    private readonly capacity = 1000,
    private readonly maxAgeMs = 2 * 60 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    for (const feed of this.feeds) {
      this.unsubscribe.push(
        feed.on('delta', (event) => {
          for (const change of event.changes) this.moves.push({ ...change, book: event.meta.book });
          this.prune();
        }),
      );
    }
  }

  stop(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe.length = 0;
  }

  /** Oldest first. */
  list(): BookMove[] {
    this.prune();
    return [...this.moves];
  }

  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs;
    while (
      this.moves.length > 0 &&
      (this.moves.length > this.capacity || Date.parse(this.moves[0]!.at) < cutoff)
    ) {
      this.moves.shift();
    }
  }
}
