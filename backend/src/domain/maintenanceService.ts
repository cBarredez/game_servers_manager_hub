import type { SqliteStore } from "../infra/sqliteStore.js";
import * as podman from "../infra/podman.js";
import type { InstanceManager } from "./instanceManager.js";
import { shouldAutoRestart, shouldRunDailyCleanup, shouldRunScheduledRestart } from "./maintenanceRules.js";

const SETTINGS_KEY = "maintenance-settings";
const LAST_CLEANUP_DATE_KEY = "maintenance-last-cleanup-date";

export interface MaintenanceSettings {
  cleanupEnabled: boolean;
  cleanupTime: string; // "HH:MM", host-local time
  crashRestartEnabled: boolean;
  maxCrashRestarts: number;
}

const DEFAULT_SETTINGS: MaintenanceSettings = {
  cleanupEnabled: true,
  cleanupTime: "03:00",
  crashRestartEnabled: true,
  maxCrashRestarts: 5,
};

function formatHHMM(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Runs one pass of unattended maintenance per tick: restart instances that
 * crashed while they were supposed to be running, fire any due per-instance
 * scheduled restarts, and run the host-wide dangling-image cleanup once a
 * day. Image-update tracking (InstanceManager.imageStatus) is deliberately
 * NOT ticked here — it's cheap enough (a couple of `git rev-parse` calls) to
 * compute live whenever the Maintenance page asks for it.
 */
export class MaintenanceService {
  constructor(
    private readonly store: SqliteStore,
    private readonly instances: InstanceManager,
  ) {}

  getSettings(): MaintenanceSettings {
    return { ...DEFAULT_SETTINGS, ...this.store.getJson<Partial<MaintenanceSettings>>(SETTINGS_KEY) };
  }

  updateSettings(patch: Partial<MaintenanceSettings>): MaintenanceSettings {
    const merged = { ...this.getSettings(), ...patch };
    this.store.setJson(SETTINGS_KEY, merged);
    return merged;
  }

  async tick(now = new Date()): Promise<void> {
    const nowHHMM = formatHHMM(now);
    const todayStr = formatDate(now);
    const settings = this.getSettings();

    await this.checkCrashedInstances(settings);
    await this.checkScheduledRestarts(nowHHMM, todayStr);
    await this.checkDailyCleanup(nowHHMM, todayStr, settings);
  }

  private async checkCrashedInstances(settings: MaintenanceSettings): Promise<void> {
    if (!settings.crashRestartEnabled) return;
    const rows = this.store.listInstances().filter((row) => row.lifecycle === "created");

    for (const row of rows) {
      const running = await this.instances.isRunning(row);
      if (!shouldAutoRestart(row, running, settings.maxCrashRestarts)) continue;

      try {
        await this.instances.restartForRecovery(row.id);
        this.store.recordCrashRestart(row.id);
        this.store.insertMaintenanceLog({
          scope: "instance",
          instanceId: row.id,
          gameType: row.gameType,
          action: "auto-restart",
          detail: `attempt ${row.crashRestartCount + 1} of ${settings.maxCrashRestarts}`,
          success: true,
        });
      } catch (error) {
        this.store.recordCrashRestart(row.id);
        this.store.insertMaintenanceLog({
          scope: "instance",
          instanceId: row.id,
          gameType: row.gameType,
          action: "auto-restart",
          detail: error instanceof Error ? error.message : String(error),
          success: false,
        });
      }
    }
  }

  private async checkScheduledRestarts(nowHHMM: string, todayStr: string): Promise<void> {
    const rows = this.store.listInstances();
    for (const row of rows) {
      if (!shouldRunScheduledRestart(row, nowHHMM, todayStr)) continue;

      try {
        await this.instances.restart(row.id);
        this.store.setLastScheduledRestartDate(row.id, todayStr);
        this.store.insertMaintenanceLog({
          scope: "instance",
          instanceId: row.id,
          gameType: row.gameType,
          action: "scheduled-restart",
          detail: `daily restart at ${row.restartSchedule}`,
          success: true,
        });
      } catch (error) {
        this.store.insertMaintenanceLog({
          scope: "instance",
          instanceId: row.id,
          gameType: row.gameType,
          action: "scheduled-restart",
          detail: error instanceof Error ? error.message : String(error),
          success: false,
        });
      }
    }
  }

  private async checkDailyCleanup(nowHHMM: string, todayStr: string, settings: MaintenanceSettings): Promise<void> {
    const lastCleanupDate = this.store.getRaw(LAST_CLEANUP_DATE_KEY) ?? null;
    if (!shouldRunDailyCleanup(settings.cleanupEnabled, settings.cleanupTime, lastCleanupDate, nowHHMM, todayStr)) {
      return;
    }

    const removed = await podman.pruneDangling();
    this.store.setRaw(LAST_CLEANUP_DATE_KEY, todayStr);
    this.store.insertMaintenanceLog({
      scope: "host",
      instanceId: null,
      gameType: null,
      action: "host-cleanup",
      detail: `removed ${removed.length} dangling image${removed.length === 1 ? "" : "s"}`,
      success: true,
    });
  }
}
