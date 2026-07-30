import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

export type GameType = "arma3" | "pz";
export type InstanceLifecycle = "creating" | "created" | "deleting" | "error";

export interface InstanceRow {
  id: string;
  slug: string;
  gameType: GameType;
  name: string;
  lifecycle: InstanceLifecycle;
  ports: string; // JSON-encoded per-template port allocation
  createdAt: string;
  errorMessage: string | null;
}

/**
 * Generic key-value store (panel auth, port-pool counters) plus the
 * `instances` table, mirroring arma_server/proyect_zomboid's SqliteStore
 * convention of keeping most mutable state as JSON blobs so new state
 * doesn't require schema migrations.
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
    `);
  }

  insertInstance(row: Omit<InstanceRow, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO instances (id, slug, game_type, name, lifecycle, ports, error_message)
         VALUES (@id, @slug, @gameType, @name, @lifecycle, @ports, @errorMessage)`,
      )
      .run({
        id: row.id,
        slug: row.slug,
        gameType: row.gameType,
        name: row.name,
        lifecycle: row.lifecycle,
        ports: row.ports,
        errorMessage: row.errorMessage,
      });
  }

  updateInstanceLifecycle(id: string, lifecycle: InstanceLifecycle, errorMessage: string | null = null): void {
    this.db
      .prepare(`UPDATE instances SET lifecycle = ?, error_message = ? WHERE id = ?`)
      .run(lifecycle, errorMessage, id);
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
  };
}
