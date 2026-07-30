import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as TOML from "smol-toml";
import type { GameType, InstanceRow } from "../infra/sqliteStore.js";
import { SqliteStore } from "../infra/sqliteStore.js";
import { PortAllocator } from "../infra/portAllocator.js";
import * as podman from "../infra/podman.js";
import { allPortsFree } from "../infra/portCheck.js";
import { getHeadCommit } from "../infra/git.js";
import { getTemplate, listTemplates } from "../templates/index.js";
import type { GameTemplate, PortMap } from "../templates/types.js";
import { makeSlug } from "./slug.js";

const MAX_PORT_ALLOCATION_ATTEMPTS = 50;

export interface InstanceSummary {
  id: string;
  slug: string;
  gameType: GameType;
  gameDisplayName: string;
  name: string;
  lifecycle: InstanceRow["lifecycle"];
  errorMessage: string | null;
  status: "running" | "stopped" | "degraded" | "creating" | "deleting" | "error";
  ports: PortMap;
  panelUrl: string;
  createdAt: string;
  memoryMb: number;
  diskGb: number;
  desiredState: InstanceRow["desiredState"];
  restartSchedule: string | null;
  crashRestartCount: number;
}

export interface CreateInstanceResult {
  instance: InstanceSummary;
  initialPassword: string;
  /** Whether the requested disk limit was actually enforced (false = host storage backend doesn't support it, instance runs unlimited). */
  diskLimitEnforced: boolean;
}

export interface InstanceCredentials {
  username: string;
  password: string;
}

interface GameImagesRecord {
  apiCommit: string | null;
  frontendCommit: string | null;
  builtAt: string;
}

interface OutdatedInstanceRef {
  id: string;
  name: string;
}

export interface GameImageStatus {
  gameType: GameType;
  displayName: string;
  currentCommit: string | null;
  builtCommit: string | null;
  builtAt: string | null;
  outdatedInstances: OutdatedInstanceRef[];
  rebuilding: boolean;
}

export interface InstanceMetrics {
  cpuPercent: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  diskUsedBytes: number;
}

function gameImagesKey(gameType: GameType): string {
  return `game-images:${gameType}`;
}

export class InstanceManager {
  /** Game types with a rebuild currently in flight, so a second click (or a second browser tab) can't kick off a duplicate concurrent `podman build`. */
  private readonly rebuildingGameTypes = new Set<GameType>();

  constructor(
    private readonly store: SqliteStore,
    private readonly allocator: PortAllocator,
    private readonly reposRoot: string,
    private readonly dataDir: string,
  ) {}

  private instanceDir(slug: string): string {
    return path.join(this.dataDir, "instances", slug);
  }

  async create(
    gameType: GameType,
    name: string,
    mock: boolean,
    memoryMb: number,
    diskGb: number,
  ): Promise<CreateInstanceResult> {
    const template = getTemplate(gameType);
    const id = randomUUID();
    const slug = makeSlug(name);
    const { webPort, ports } = await this.allocateFreePorts(template, gameType);

    const configDir = path.join(this.instanceDir(slug), "config");
    const ctx = { id, slug, name, mock, configDir, memoryMb, diskGb };

    this.store.insertInstance({
      id,
      slug,
      gameType,
      name,
      lifecycle: "creating",
      ports: JSON.stringify(ports),
      errorMessage: null,
      memoryMb,
      diskGb,
      mock,
      desiredState: "running",
      imageCommitApi: null,
      imageCommitFrontend: null,
    });

    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, "manager.toml"), template.renderConfigToml(ctx, ports), "utf-8");
      const secrets = template.generateSecrets(ctx);
      await writeFile(path.join(configDir, "manager.secrets.toml"), secrets.content, "utf-8");

      await this.ensureImages(template);
      const imageRecord = this.store.getJson<GameImagesRecord>(gameImagesKey(gameType));
      this.store.setImageCommits(id, imageRecord?.apiCommit ?? null, imageRecord?.frontendCommit ?? null);

      const network = template.networkName(slug);
      await podman.networkCreate(network);
      // Only meaningful when diskGb > 0 — stays true (nothing to fail) if no
      // disk limit was requested at all.
      let diskLimitEnforced = true;
      for (const volume of template.volumes(slug)) {
        if (volume.sizeable && diskGb > 0) {
          const applied = await podman.volumeCreateSized(volume.name, diskGb);
          diskLimitEnforced = diskLimitEnforced && applied;
        } else {
          await podman.volumeCreate(volume.name);
        }
      }

      await podman.run([...template.apiRunArgs(ctx, ports), template.images.api]);
      await podman.run([...template.frontendRunArgs(ctx, ports), template.images.frontend]);

      this.store.updateInstanceLifecycle(id, "created");

      return {
        instance: await this.toSummaryWithLiveStatus(this.store.getInstance(id)!),
        initialPassword: secrets.initialPassword,
        diskLimitEnforced,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateInstanceLifecycle(id, "error", message);
      throw error;
    }
  }

  /**
   * Allocates a web port and a game-specific port block, verifying every
   * port is actually free on the host right now (not just unused by other
   * hub-managed instances) before committing to it. Retries forward through
   * each pool on the first collision found, e.g. against a manually-run
   * copy of arma_server/proyect_zomboid, or anything else already listening.
   */
  private async allocateFreePorts(
    template: GameTemplate,
    gameType: GameType,
  ): Promise<{ webPort: number; ports: PortMap }> {
    let webPort: number | undefined;
    for (let attempt = 0; attempt < MAX_PORT_ALLOCATION_ATTEMPTS; attempt++) {
      const candidate = this.allocator.allocateWebPort();
      if (await allPortsFree([{ port: candidate, protocol: "tcp" }])) {
        webPort = candidate;
        break;
      }
    }
    if (webPort === undefined) {
      throw new Error(`could not find a free web port after ${MAX_PORT_ALLOCATION_ATTEMPTS} attempts`);
    }

    for (let attempt = 0; attempt < MAX_PORT_ALLOCATION_ATTEMPTS; attempt++) {
      const gameIndex = this.allocator.allocateGameIndex(gameType);
      const ports = template.allocatePorts(gameIndex, webPort);
      if (await allPortsFree(template.portsToCheck(ports))) {
        return { webPort, ports };
      }
    }
    throw new Error(`could not find a free ${gameType} port block after ${MAX_PORT_ALLOCATION_ATTEMPTS} attempts`);
  }

  async list(): Promise<InstanceSummary[]> {
    const rows = this.store.listInstances();
    return Promise.all(rows.map((row) => this.toSummaryWithLiveStatus(row)));
  }

  async get(id: string): Promise<InstanceSummary | undefined> {
    const row = this.store.getInstance(id);
    return row ? this.toSummaryWithLiveStatus(row) : undefined;
  }

  async getCredentials(id: string): Promise<InstanceCredentials> {
    const row = this.requireRow(id);
    const secretsPath = path.join(this.instanceDir(row.slug), "config", "manager.secrets.toml");
    const raw = await readFile(secretsPath, "utf-8");
    const parsed = TOML.parse(raw) as { web?: { password?: unknown } };
    const password = typeof parsed.web?.password === "string" ? parsed.web.password : "";
    return { username: "admin", password };
  }

  async start(id: string): Promise<void> {
    const row = this.requireRow(id);
    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);
    await podman.start(names.api);
    await podman.start(names.frontend);
    this.store.setDesiredState(id, "running");
    this.store.resetCrashRestartCount(id);
  }

  async stop(id: string): Promise<void> {
    const row = this.requireRow(id);
    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);
    this.store.setDesiredState(id, "stopped");
    await podman.stop(names.frontend);
    await podman.stop(names.api);
  }

  async restart(id: string): Promise<void> {
    const row = this.requireRow(id);
    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);
    await podman.restart(names.api);
    await podman.restart(names.frontend);
    this.store.resetCrashRestartCount(id);
  }

  /**
   * Same as restart(), but for the maintenance scheduler's crash-recovery
   * path: it does NOT reset crashRestartCount, since the scheduler is the
   * one incrementing it (via store.recordCrashRestart) to enforce a max
   * retry budget across repeated failures.
   */
  async restartForRecovery(id: string): Promise<void> {
    const row = this.requireRow(id);
    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);
    await podman.restart(names.api);
    await podman.restart(names.frontend);
  }

  /** Whether both of an instance's containers are currently running. */
  async isRunning(row: InstanceRow): Promise<boolean> {
    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);
    const [apiStatus, frontendStatus] = await Promise.all([
      podman.containerStatus(names.api),
      podman.containerStatus(names.frontend),
    ]);
    return apiStatus === "running" && frontendStatus === "running";
  }

  /** Like restart, but swaps the containers onto whatever image currently carries the game's tag (e.g. after rebuildImages), instead of reusing the original container's image. */
  async recreate(id: string): Promise<void> {
    const row = this.requireRow(id);
    const template = getTemplate(row.gameType);
    const ports = JSON.parse(row.ports) as PortMap;
    const configDir = path.join(this.instanceDir(row.slug), "config");
    const ctx = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      mock: row.mock,
      configDir,
      memoryMb: row.memoryMb,
      diskGb: row.diskGb,
    };
    const names = template.containerNames(row.slug);

    await podman.removeContainer(names.frontend);
    await podman.removeContainer(names.api);
    await podman.run([...template.apiRunArgs(ctx, ports), template.images.api]);
    await podman.run([...template.frontendRunArgs(ctx, ports), template.images.frontend]);

    const imageRecord = this.store.getJson<GameImagesRecord>(gameImagesKey(row.gameType));
    this.store.setImageCommits(id, imageRecord?.apiCommit ?? null, imageRecord?.frontendCommit ?? null);
    this.store.resetCrashRestartCount(id);
    this.store.insertMaintenanceLog({
      scope: "instance",
      instanceId: id,
      gameType: row.gameType,
      action: "recreate",
      detail: `recreated from current ${row.gameType} image`,
      success: true,
    });
  }

  setSchedule(id: string, time: string | null): void {
    this.requireRow(id);
    if (time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new Error('restart schedule must be "HH:MM" (24h) or null');
    }
    this.store.setRestartSchedule(id, time);
  }

  /**
   * Changes an instance's memory/disk limits at any time, not just at
   * creation. Memory takes effect immediately via `podman update` (no
   * restart needed) since Podman supports live container memory changes.
   * Disk has no live equivalent — Podman can't resize an existing volume —
   * so the new value is only saved for the next recreate() (and even then,
   * best-effort, same as at creation: only enforced on storage backends
   * with quota support).
   */
  async updateResources(id: string, memoryMb: number, diskGb: number): Promise<{ memoryApplied: boolean }> {
    const row = this.requireRow(id);
    if (!Number.isInteger(memoryMb) || memoryMb < 512) {
      throw new Error("memoryMb must be at least 512");
    }
    if (!Number.isInteger(diskGb) || diskGb < 0) {
      throw new Error("diskGb must be 0 (unlimited) or greater");
    }

    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);
    const memoryApplied = await podman.updateMemory(names.api, memoryMb);

    this.store.setResourceLimits(id, memoryMb, diskGb);
    this.store.insertMaintenanceLog({
      scope: "instance",
      instanceId: id,
      gameType: row.gameType,
      action: "resource-update",
      detail: `memory -> ${memoryMb}m (${memoryApplied ? "applied live" : "container not found, saved for next start"}), disk -> ${diskGb === 0 ? "unlimited" : diskGb + "GB"} (applies on next recreate only)`,
      success: true,
    });

    return { memoryApplied };
  }

  async delete(id: string, removeVolumes: boolean): Promise<void> {
    const row = this.requireRow(id);
    this.store.updateInstanceLifecycle(id, "deleting");
    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);

    await podman.removeContainer(names.frontend);
    await podman.removeContainer(names.api);
    await podman.networkRemove(template.networkName(row.slug));
    if (removeVolumes) {
      for (const volume of template.volumes(row.slug)) {
        await podman.volumeRemove(volume.name);
      }
    }
    await rm(this.instanceDir(row.slug), { recursive: true, force: true });
    this.store.deleteInstance(id);
  }

  /** Builds both images for a game type unconditionally (unlike ensureImages, which skips if the tag already exists) and records the source commit that produced them. */
  async rebuildImages(gameType: GameType): Promise<GameImagesRecord> {
    if (this.rebuildingGameTypes.has(gameType)) {
      throw new Error(`a rebuild for ${gameType} is already in progress — wait for it to finish first`);
    }
    this.rebuildingGameTypes.add(gameType);
    try {
      const template = getTemplate(gameType);
      const contextDir = path.join(this.reposRoot, template.repoDirName);
      const commit = await getHeadCommit(contextDir);
      const builtAt = new Date().toISOString();
      const buildArgs = { GIT_COMMIT: commit ?? "unknown", BUILD_DATE: builtAt };
      await podman.build(contextDir, path.join(contextDir, "Containerfile.api"), template.images.api, buildArgs);
      await podman.build(
        contextDir,
        path.join(contextDir, "Containerfile.frontend"),
        template.images.frontend,
        buildArgs,
      );

      const record: GameImagesRecord = { apiCommit: commit, frontendCommit: commit, builtAt };
      this.store.setJson(gameImagesKey(gameType), record);
      this.store.insertMaintenanceLog({
        scope: "image",
        instanceId: null,
        gameType,
        action: "image-rebuild",
        detail: commit ? `built from commit ${commit.slice(0, 12)}` : "built (source is not a git repo)",
        success: true,
      });
      return record;
    } finally {
      this.rebuildingGameTypes.delete(gameType);
    }
  }

  /** Whether a rebuild for this game type is currently running, so the UI can show a persistent "in progress" state across page reloads instead of relying on local button state alone. */
  isRebuilding(gameType: GameType): boolean {
    return this.rebuildingGameTypes.has(gameType);
  }

  /** Live comparison of each game's current source commit against what every existing instance was built from — no periodic job needed, this is cheap enough to compute on demand. */
  async imageStatus(): Promise<GameImageStatus[]> {
    const rows = this.store.listInstances();
    return Promise.all(
      listTemplates().map(async (template) => {
        const contextDir = path.join(this.reposRoot, template.repoDirName);
        const currentCommit = await getHeadCommit(contextDir);
        const record = this.store.getJson<GameImagesRecord>(gameImagesKey(template.gameType));
        const outdatedInstances = rows
          .filter(
            (row) =>
              row.gameType === template.gameType &&
              row.lifecycle === "created" &&
              currentCommit !== null &&
              row.imageCommitApi !== currentCommit,
          )
          .map((row) => ({ id: row.id, name: row.name }));
        return {
          gameType: template.gameType,
          displayName: template.displayName,
          currentCommit,
          builtCommit: record?.apiCommit ?? null,
          builtAt: record?.builtAt ?? null,
          outdatedInstances,
          rebuilding: this.isRebuilding(template.gameType),
        };
      }),
    );
  }

  /** Live CPU/RAM (from the api container — the one with a real --memory limit; the frontend is negligible nginx overhead) and disk usage (summed across the instance's "sizeable" data volumes) for every created instance, in one batch. */
  async getAllMetrics(): Promise<Record<string, InstanceMetrics>> {
    const rows = this.store.listInstances().filter((row) => row.lifecycle === "created");
    const volumeUsage = await podman.volumeDiskUsage();
    const entries = await Promise.all(
      rows.map(async (row) => [row.id, await this.computeMetrics(row, volumeUsage)] as const),
    );
    return Object.fromEntries(entries);
  }

  async getMetrics(id: string): Promise<InstanceMetrics> {
    const row = this.requireRow(id);
    return this.computeMetrics(row, await podman.volumeDiskUsage());
  }

  private async computeMetrics(row: InstanceRow, volumeUsage: Map<string, number>): Promise<InstanceMetrics> {
    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);
    const stats = await podman.containerStats(names.api);
    const diskUsedBytes = template
      .volumes(row.slug)
      .filter((volume) => volume.sizeable)
      .reduce((sum, volume) => sum + (volumeUsage.get(volume.name) ?? 0), 0);

    return {
      cpuPercent: stats?.cpuPercent ?? null,
      memUsedBytes: stats?.memUsedBytes ?? null,
      memLimitBytes: stats?.memLimitBytes ?? null,
      diskUsedBytes,
    };
  }

  private async ensureImages(template: GameTemplate): Promise<void> {
    const contextDir = path.join(this.reposRoot, template.repoDirName);
    const apiExists = await podman.imageExists(template.images.api);
    const frontendExists = await podman.imageExists(template.images.frontend);
    if (apiExists && frontendExists) return;

    const commit = await getHeadCommit(contextDir);
    const builtAt = new Date().toISOString();
    const buildArgs = { GIT_COMMIT: commit ?? "unknown", BUILD_DATE: builtAt };

    if (!apiExists) {
      await podman.build(contextDir, path.join(contextDir, "Containerfile.api"), template.images.api, buildArgs);
    }
    if (!frontendExists) {
      await podman.build(
        contextDir,
        path.join(contextDir, "Containerfile.frontend"),
        template.images.frontend,
        buildArgs,
      );
    }
    if (!this.store.getJson<GameImagesRecord>(gameImagesKey(template.gameType))) {
      this.store.setJson<GameImagesRecord>(gameImagesKey(template.gameType), {
        apiCommit: commit,
        frontendCommit: commit,
        builtAt,
      });
    }
  }

  private requireRow(id: string): InstanceRow {
    const row = this.store.getInstance(id);
    if (!row) throw new Error(`instance not found: ${id}`);
    return row;
  }

  private toSummary(row: InstanceRow): InstanceSummary {
    const template = getTemplate(row.gameType);
    const ports = JSON.parse(row.ports) as PortMap;
    return {
      id: row.id,
      slug: row.slug,
      gameType: row.gameType,
      gameDisplayName: template.displayName,
      name: row.name,
      lifecycle: row.lifecycle,
      errorMessage: row.errorMessage,
      status: row.lifecycle === "created" ? "stopped" : row.lifecycle,
      ports,
      panelUrl: template.panelUrl(ports),
      createdAt: row.createdAt,
      memoryMb: row.memoryMb,
      diskGb: row.diskGb,
      desiredState: row.desiredState,
      restartSchedule: row.restartSchedule,
      crashRestartCount: row.crashRestartCount,
    };
  }

  private async toSummaryWithLiveStatus(row: InstanceRow): Promise<InstanceSummary> {
    const summary = this.toSummary(row);
    if (row.lifecycle !== "created") return summary;

    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);
    const [apiStatus, frontendStatus] = await Promise.all([
      podman.containerStatus(names.api),
      podman.containerStatus(names.frontend),
    ]);

    if (apiStatus === "running" && frontendStatus === "running") {
      summary.status = "running";
    } else if (apiStatus === "missing" && frontendStatus === "missing") {
      summary.status = "stopped";
    } else if (apiStatus === "stopped" && frontendStatus === "stopped") {
      summary.status = "stopped";
    } else {
      summary.status = "degraded";
    }
    return summary;
  }
}
