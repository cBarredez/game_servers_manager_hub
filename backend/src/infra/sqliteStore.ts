import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

export type GameType = "arma3" | "pz";
export type InstanceLifecycle = "creating" | "created" | "deleting" | "error";
export type DesiredState = "running" | "stopped";
export type MaintenanceScope = "instance" | "image" | "host";

export interface InstanceRow {
  id: string;
  slug: string;
  gameType: GameType;
  name: string;
  lifecycle: InstanceLifecycle;
  ports: string; // JSON-encoded per-template port allocation
  createdAt: string;
  errorMessage: string | null;
  memoryMb: number;
  diskGb: number;
  mock: boolean;
  desiredState: DesiredState;
  restartSchedule: string | null; // "HH:MM", null = disabled
  lastScheduledRestartDate: string | null; // "YYYY-MM-DD"
  crashRestartCount: number;
  lastCrashRestartAt: string | null;
  imageCommitApi: string | null;
  imageCommitFrontend: string | null;
}

export interface MaintenanceLogRow {
  id: number;
  timestamp: string;
  scope: MaintenanceScope;
  instanceId: string | null;
  gameType: GameType | null;
  action: string;
  detail: string | null;
  success: boolean;
}

/** Columns added after the initial `instances` table shipped, applied via a guarded ALTER TABLE migration below. */
const INSTANCE_COLUMN_MIGRATIONS: { name: string; ddl: string }[] = [
  { name: "memory_mb", ddl: "ALTER TABLE instances ADD COLUMN memory_mb INTEGER NOT NULL DEFAULT 4096" },
  { name: "disk_gb", ddl: "ALTER TABLE instances ADD COLUMN disk_gb INTEGER NOT NULL DEFAULT 0" },
  { name: "mock", ddl: "ALTER TABLE instances ADD COLUMN mock INTEGER NOT NULL DEFAULT 0" },
  {
    name: "desired_state",
    ddl: "ALTER TABLE instances ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'running'",
  },
  { name: "restart_schedule", ddl: "ALTER TABLE instances ADD COLUMN restart_schedule TEXT" },
  {
    name: "last_scheduled_restart_date",
    ddl: "ALTER TABLE instances ADD COLUMN last_scheduled_restart_date TEXT",
  },
  {
    name: "crash_restart_count",
    ddl: "ALTER TABLE instances ADD COLUMN crash_restart_count INTEGER NOT NULL DEFAULT 0",
  },
  { name: "last_crash_restart_at", ddl: "ALTER TABLE instances ADD COLUMN last_crash_restart_at TEXT" },
  { name: "image_commit_api", ddl: "ALTER TABLE instances ADD COLUMN image_commit_api TEXT" },
  { name: "image_commit_frontend", ddl: "ALTER TABLE instances ADD COLUMN image_commit_frontend TEXT" },
];

/**
 * Generic key-value store (panel auth, port-pool counters, per-game-type
 * image build records) plus the `instances` and `maintenance_log` tables,
 * mirroring arma_server/proyect_zomboid's SqliteStore convention of keeping
 * most mutable state as JSON blobs so new state doesn't require schema
 * migrations — except for `instances`, which is queried/filtered enough
 * (by the maintenance scheduler) to warrant real columns.
 */
export class SqliteStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        game_type TEXT NOT NULL,
        name TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        ports TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS maintenance_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        scope TEXT NOT NULL,
        instance_id TEXT,
        game_type TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        success INTEGER NOT NULL
      );
    `);
    this.migrateInstanceColumns();
  }

  private migrateInstanceColumns(): void {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(instances)`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const migration of INSTANCE_COLUMN_MIGRATIONS) {
      if (!existing.has(migration.name)) this.db.exec(migration.ddl);
    }
  }

  insertInstance(
    row: Omit<
      InstanceRow,
      "createdAt" | "restartSchedule" | "lastScheduledRestartDate" | "crashRestartCount" | "lastCrashRestartAt"
    >,
  ): void {
    this.db
      .prepare(
        `INSERT INTO instances (
           id, slug, game_type, name, lifecycle, ports, error_message,
           memory_mb, disk_gb, mock, desired_state, image_commit_api, image_commit_frontend
         ) VALUES (
           @id, @slug, @gameType, @name, @lifecycle, @ports, @errorMessage,
           @memoryMb, @diskGb, @mock, @desiredState, @imageCommitApi, @imageCommitFrontend
         )`,
      )
      .run({
        id: row.id,
        slug: row.slug,
        gameType: row.gameType,
        name: row.name,
        lifecycle: row.lifecycle,
        ports: row.ports,
        errorMessage: row.errorMessage,
        memoryMb: row.memoryMb,
        diskGb: row.diskGb,
        mock: row.mock ? 1 : 0,
        desiredState: row.desiredState,
        imageCommitApi: row.imageCommitApi,
        imageCommitFrontend: row.imageCommitFrontend,
      });
  }

  updateInstanceLifecycle(id: string, lifecycle: InstanceLifecycle, errorMessage: string | null = null): void {
    this.db
      .prepare(`UPDATE instances SET lifecycle = ?, error_message = ? WHERE id = ?`)
      .run(lifecycle, errorMessage, id);
  }

  setDesiredState(id: string, desiredState: DesiredState): void {
    this.db.prepare(`UPDATE instances SET desired_state = ? WHERE id = ?`).run(desiredState, id);
  }

  resetCrashRestartCount(id: string): void {
    this.db.prepare(`UPDATE instances SET crash_restart_count = 0 WHERE id = ?`).run(id);
  }

  recordCrashRestart(id: string): void {
    this.db
      .prepare(
        `UPDATE instances SET crash_restart_count = crash_restart_count + 1, last_crash_restart_at = datetime('now') WHERE id = ?`,
      )
      .run(id);
  }

  setLastScheduledRestartDate(id: string, date: string): void {
    this.db.prepare(`UPDATE instances SET last_scheduled_restart_date = ? WHERE id = ?`).run(date, id);
  }

  setRestartSchedule(id: string, time: string | null): void {
    this.db.prepare(`UPDATE instances SET restart_schedule = ? WHERE id = ?`).run(time, id);
  }

  setImageCommits(id: string, apiCommit: string | null, frontendCommit: string | null): void {
    this.db
      .prepare(`UPDATE instances SET image_commit_api = ?, image_commit_frontend = ? WHERE id = ?`)
      .run(apiCommit, frontendCommit, id);
  }

  deleteInstance(id: string): void {
    this.db.prepare(`DELETE FROM instances WHERE id = ?`).run(id);
  }

  getInstance(id: string): InstanceRow | undefined {
    const row = this.db.prepare(`SELECT * FROM instances WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapInstanceRow(row) : undefined;
  }

  listInstances(): InstanceRow[] {
    const rows = this.db.prepare(`SELECT * FROM instances ORDER BY created_at ASC`).all() as Record<
      string,
      unknown
    >[];
    return rows.map(mapInstanceRow);
  }

  insertMaintenanceLog(entry: {
    scope: MaintenanceScope;
    instanceId: string | null;
    gameType: GameType | null;
    action: string;
    detail: string | null;
    success: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_log (scope, instance_id, game_type, action, detail, success)
         VALUES (@scope, @instanceId, @gameType, @action, @detail, @success)`,
      )
      .run({ ...entry, success: entry.success ? 1 : 0 });
  }

  listMaintenanceLog(limit: number): MaintenanceLogRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM maintenance_log ORDER BY id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as number,
      timestamp: row.timestamp as string,
      scope: row.scope as MaintenanceScope,
      instanceId: (row.instance_id as string | null) ?? null,
      gameType: (row.game_type as GameType | null) ?? null,
      action: row.action as string,
      detail: (row.detail as string | null) ?? null,
      success: Boolean(row.success),
    }));
  }

  getRaw(key: string): string | undefined {
    const row = this.db
      .prepare<[string], { value: string }>("SELECT value FROM kv_state WHERE key = ?")
      .get(key);
    return row?.value;
  }

  setRaw(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value);
  }

  getJson<T>(key: string): T | undefined {
    const raw = this.getRaw(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  setJson<T>(key: string, value: T): void {
    this.setRaw(key, JSON.stringify(value));
  }

  close(): void {
    this.db.close();
  }
}

function mapInstanceRow(row: Record<string, unknown>): InstanceRow {
  return {
    id: row.id as string,
    slug: row.slug as string,
    gameType: row.game_type as GameType,
    name: row.name as string,
    lifecycle: row.lifecycle as InstanceLifecycle,
    ports: row.ports as string,
    createdAt: row.created_at as string,
    errorMessage: (row.error_message as string | null) ?? null,
    memoryMb: row.memory_mb as number,
    diskGb: row.disk_gb as number,
    mock: Boolean(row.mock),
    desiredState: row.desired_state as DesiredState,
    restartSchedule: (row.restart_schedule as string | null) ?? null,
    lastScheduledRestartDate: (row.last_scheduled_restart_date as string | null) ?? null,
    crashRestartCount: row.crash_restart_count as number,
    lastCrashRestartAt: (row.last_crash_restart_at as string | null) ?? null,
    imageCommitApi: (row.image_commit_api as string | null) ?? null,
    imageCommitFrontend: (row.image_commit_frontend as string | null) ?? null,
  };
}
