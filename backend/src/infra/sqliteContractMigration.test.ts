import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SqliteStore } from "./sqliteStore.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("contract instance persistence", () => {
  it("migrates pre-contract rows to legacy without inventing controller metadata", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hub-legacy-db-"));
    directories.push(directory);
    const databasePath = path.join(directory, "hub.sqlite3");
    const old = new Database(databasePath);
    old.exec(`
      CREATE TABLE instances (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, game_type TEXT NOT NULL,
        name TEXT NOT NULL, lifecycle TEXT NOT NULL, ports TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), error_message TEXT
      );
      INSERT INTO instances (id, slug, game_type, name, lifecycle, ports)
      VALUES ('old-row', 'old-server', 'pz', 'Old server', 'created', '{}');
    `);
    old.close();

    const store = new SqliteStore(databasePath);
    const migrated = store.getInstance("old-row")!;
    expect(migrated.origin).toBe("legacy");
    expect(migrated.managerId).toBeNull();
    expect(migrated.externalInstanceId).toBeNull();
    expect(migrated.resourceManifest).toBeNull();
    store.close();
  });

  it("persists adopted origin and controller metadata without secret fields", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hub-contract-db-"));
    directories.push(directory);
    const store = new SqliteStore(path.join(directory, "hub.sqlite3"));
    const manifest = JSON.stringify({ contractVersion: "1.0", secrets: [{ provider: "podman", reference: "secret-ref" }] });
    store.insertInstance({
      id: "row-1",
      slug: "adopted-row",
      gameType: "arma3",
      name: "Existing server",
      lifecycle: "created",
      ports: "{}",
      errorMessage: null,
      memoryMb: 8192,
      diskGb: 0,
      mock: false,
      desiredState: "running",
      imageCommitApi: null,
      imageCommitFrontend: null,
      origin: "adopted",
      managerId: "arma3-server-manager",
      externalInstanceId: "a".repeat(32),
      contractVersion: "1.0",
      driverRef: '["/usr/bin/python3","/srv/manager_driver.py"]',
      resourceManifest: manifest,
      controllerRevision: 1,
    });
    const row = store.getInstance("row-1")!;
    expect(row.origin).toBe("adopted");
    expect(row.externalInstanceId).toBe("a".repeat(32));
    expect(row.controllerRevision).toBe(1);
    expect(row.resourceManifest).toBe(manifest);
    store.close();
  });
});
