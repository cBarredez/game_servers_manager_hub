import { describe, expect, it } from "vitest";
import type { InstanceRow } from "../infra/sqliteStore.js";
import { shouldAutoRestart, shouldRunDailyCleanup, shouldRunScheduledRestart } from "./maintenanceRules.js";

function makeRow(overrides: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: "abc",
    slug: "test-slug",
    gameType: "arma3",
    name: "Test",
    lifecycle: "created",
    ports: "{}",
    createdAt: "2026-01-01",
    errorMessage: null,
    memoryMb: 4096,
    diskGb: 0,
    mock: true,
    desiredState: "running",
    restartSchedule: null,
    lastScheduledRestartDate: null,
    crashRestartCount: 0,
    lastCrashRestartAt: null,
    imageCommitApi: null,
    imageCommitFrontend: null,
    ...overrides,
  };
}

describe("shouldAutoRestart", () => {
  it("restarts a crashed instance under the attempt limit", () => {
    expect(shouldAutoRestart(makeRow({ crashRestartCount: 2 }), false, 5)).toBe(true);
  });

  it("does not restart when the instance is already running", () => {
    expect(shouldAutoRestart(makeRow(), true, 5)).toBe(false);
  });

  it("does not restart when the user deliberately stopped it", () => {
    expect(shouldAutoRestart(makeRow({ desiredState: "stopped" }), false, 5)).toBe(false);
  });

  it("gives up once the attempt limit is reached", () => {
    expect(shouldAutoRestart(makeRow({ crashRestartCount: 5 }), false, 5)).toBe(false);
  });

  it("ignores instances still creating/deleting/errored", () => {
    expect(shouldAutoRestart(makeRow({ lifecycle: "creating" }), false, 5)).toBe(false);
    expect(shouldAutoRestart(makeRow({ lifecycle: "error" }), false, 5)).toBe(false);
  });
});

describe("shouldRunScheduledRestart", () => {
  it("fires once the scheduled time has passed and it hasn't run today", () => {
    const row = makeRow({ restartSchedule: "03:00", lastScheduledRestartDate: "2026-01-01" });
    expect(shouldRunScheduledRestart(row, "03:05", "2026-01-02")).toBe(true);
  });

  it("does not fire before the scheduled time", () => {
    const row = makeRow({ restartSchedule: "03:00" });
    expect(shouldRunScheduledRestart(row, "02:59", "2026-01-02")).toBe(false);
  });

  it("does not fire twice on the same day", () => {
    const row = makeRow({ restartSchedule: "03:00", lastScheduledRestartDate: "2026-01-02" });
    expect(shouldRunScheduledRestart(row, "10:00", "2026-01-02")).toBe(false);
  });

  it("does nothing when no schedule is set", () => {
    expect(shouldRunScheduledRestart(makeRow({ restartSchedule: null }), "12:00", "2026-01-02")).toBe(false);
  });
});

describe("shouldRunDailyCleanup", () => {
  it("runs once the configured time has passed and it hasn't run today", () => {
    expect(shouldRunDailyCleanup(true, "03:00", "2026-01-01", "03:30", "2026-01-02")).toBe(true);
  });

  it("does nothing when disabled", () => {
    expect(shouldRunDailyCleanup(false, "03:00", null, "12:00", "2026-01-02")).toBe(false);
  });

  it("does not run twice on the same day", () => {
    expect(shouldRunDailyCleanup(true, "03:00", "2026-01-02", "12:00", "2026-01-02")).toBe(false);
  });

  it("waits for the configured time on the first run", () => {
    expect(shouldRunDailyCleanup(true, "03:00", null, "01:00", "2026-01-02")).toBe(false);
  });
});
