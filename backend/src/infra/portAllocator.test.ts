import { describe, expect, it } from "vitest";
import { SqliteStore } from "./sqliteStore.js";
import { PortAllocator } from "./portAllocator.js";

describe("PortAllocator", () => {
  it("hands out sequential web ports starting from the configured base", () => {
    const store = new SqliteStore(":memory:");
    const allocator = new PortAllocator(store, 9000);

    expect(allocator.allocateWebPort()).toBe(9000);
    expect(allocator.allocateWebPort()).toBe(9001);
    expect(allocator.allocateWebPort()).toBe(9002);
  });

  it("tracks a separate 0-based counter per game type", () => {
    const store = new SqliteStore(":memory:");
    const allocator = new PortAllocator(store, 9000);

    expect(allocator.allocateGameIndex("arma3")).toBe(0);
    expect(allocator.allocateGameIndex("arma3")).toBe(1);
    expect(allocator.allocateGameIndex("pz")).toBe(0);
    expect(allocator.allocateGameIndex("pz")).toBe(1);
    expect(allocator.allocateGameIndex("arma3")).toBe(2);
  });
});
