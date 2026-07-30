import type { InstanceRow } from "../infra/sqliteStore.js";

/**
 * Pure decision functions for the maintenance scheduler, kept separate from
 * any podman/filesystem I/O so they're trivial to unit test with plain
 * objects instead of a running Podman instance.
 */

/** True when a `created` instance that's supposed to be running (desiredState) isn't actually running, and hasn't already exhausted its retry budget. */
export function shouldAutoRestart(row: InstanceRow, isRunning: boolean, maxAttempts: number): boolean {
  if (row.lifecycle !== "created") return false;
  if (row.desiredState !== "running") return false;
  if (isRunning) return false;
  return row.crashRestartCount < maxAttempts;
}

/** True when an instance has an opt-in daily restart time set, that time has passed for "today", and it hasn't already fired today. */
export function shouldRunScheduledRestart(row: InstanceRow, nowHHMM: string, todayStr: string): boolean {
  if (row.lifecycle !== "created") return false;
  if (!row.restartSchedule) return false;
  if (row.lastScheduledRestartDate === todayStr) return false;
  return nowHHMM >= row.restartSchedule;
}

/** True when host-wide dangling-image cleanup is enabled, its configured time has passed for "today", and it hasn't already run today. */
export function shouldRunDailyCleanup(
  enabled: boolean,
  cleanupTime: string,
  lastCleanupDate: string | null,
  nowHHMM: string,
  todayStr: string,
): boolean {
  if (!enabled) return false;
  if (lastCleanupDate === todayStr) return false;
  return nowHHMM >= cleanupTime;
}
