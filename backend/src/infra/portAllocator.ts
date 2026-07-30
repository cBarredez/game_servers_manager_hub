import type { GameType } from "./sqliteStore.js";
import type { SqliteStore } from "./sqliteStore.js";

/**
 * Monotonic port-pool counters backed by the hub's kv_state table. Each pool
 * only ever counts up — ports freed by deleting an instance are not reused,
 * which is deliberately simple for v1 (no free-list) and avoids handing out a
 * port that might still be in a TIME_WAIT state from a just-stopped container.
 */
export class PortAllocator {
  constructor(
    private readonly store: SqliteStore,
    private readonly webPortBase: number,
  ) {}

  /** Next free host port from the pool shared by every instance's web panel. */
  allocateWebPort(): number {
    return this.nextCounter("port-counter:web", this.webPortBase);
  }

  /** Next 0-based index for this game type, used to derive its game-specific port block. */
  allocateGameIndex(gameType: GameType): number {
    return this.nextCounter(`port-counter:game:${gameType}`, 0);
  }

  private nextCounter(key: string, base: number): number {
    const current = this.store.getJson<number>(key);
    const value = current ?? base;
    this.store.setJson(key, value + 1);
    return value;
  }
}
