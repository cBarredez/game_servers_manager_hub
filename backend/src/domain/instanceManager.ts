import path from "node:path";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as TOML from "smol-toml";
import type { GameType, InstanceRow } from "../infra/sqliteStore.js";
import { SqliteStore } from "../infra/sqliteStore.js";
import { PortAllocator } from "../infra/portAllocator.js";
import * as podman from "../infra/podman.js";
import { allPortsFree } from "../infra/portCheck.js";
import { getHeadCommit, pull } from "../infra/git.js";
import type { GameTemplate, PortMap } from "../templates/types.js";
import { makeSlug } from "./slug.js";
import {
  getContractAdapter,
  getLegacyTemplateAdapter,
  listContractAdapters,
  listLegacyTemplateAdapters,
} from "../adapters/index.js";
import { validateRuntimeManifest } from "../adapters/driverClient.js";
import type { DiscoveryCandidate, RuntimeInstanceManifest } from "../adapters/index.js";

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
  /** True once "Recreate from latest image" was requested while this instance was running — the swap is deferred until it next starts (manually, on schedule, or via crash recovery) instead of interrupting it immediately. */
  pendingRecreate: boolean;
  origin: InstanceRow["origin"];
  credentialsMode: "recoverable-legacy" | "manager-owned";
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
  pulling: boolean;
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
  /** Which operation (if any) is in flight for a game type — pull and rebuild share this lock so a rebuild can never read a working tree that a concurrent pull is still rewriting, and vice versa. */
  private readonly activeGameOperations = new Map<GameType, "pull" | "rebuild">();
  private readonly controllerId: string;

  constructor(
    private readonly store: SqliteStore,
    private readonly allocator: PortAllocator,
    private readonly reposRoot: string,
    private readonly dataDir: string,
  ) {
    const existing = this.store.getRaw("hub-controller-id");
    this.controllerId = existing ?? `hub-${randomUUID()}`;
    if (!existing) this.store.setRaw("hub-controller-id", this.controllerId);
  }

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
    return this.provisionInstance(gameType, name, mock, memoryMb, diskGb);
  }

  /** Contract-based discovery is read-only and delegates identity validation to each trusted adapter/driver. */
  async discover(): Promise<DiscoveryCandidate[]> {
    const results = await Promise.all(listContractAdapters().map((adapter) => adapter.discover()));
    const registered = new Set(
      this.store
        .listInstances()
        .map((row) => row.externalInstanceId)
        .filter((id): id is string => id !== null),
    );
    return results.flat().map((candidate) =>
      registered.has(candidate.instanceId) ? { ...candidate, status: "already-claimed" as const } : candidate,
    );
  }

  /** Repairs either side of the claim/SQLite crash window before maintenance starts. */
  async reconcileClaims(): Promise<void> {
    const rawCandidates = (await Promise.all(listContractAdapters().map((adapter) => adapter.discover()))).flat();
    const rows = this.store.listInstances();

    for (const row of rows.filter((candidate) => candidate.origin === "adopted" && candidate.externalInstanceId)) {
      const candidate = rawCandidates.find((item) => item.instanceId === row.externalInstanceId);
      if (!candidate || !row.managerId) continue;
      if (candidate.status === "ready") {
        const claim = await getContractAdapter(row.managerId).claim(candidate, this.controllerId);
        this.store.updateContractState(row.id, JSON.stringify(claim.manifest), claim.controller.revision);
      } else if (candidate.status === "already-claimed" && candidate.controller?.controllerId === this.controllerId) {
        this.store.updateContractState(row.id, JSON.stringify(candidate.manifest), candidate.controller.revision);
      } else if (candidate.controller && candidate.controller.controllerId !== this.controllerId) {
        this.store.updateInstanceLifecycle(row.id, "error", "instance ownership moved to another controller");
      }
    }

    const registered = new Set(rows.map((row) => row.externalInstanceId).filter(Boolean));
    for (const candidate of rawCandidates) {
      if (
        !registered.has(candidate.instanceId) &&
        candidate.status === "already-claimed" &&
        candidate.controller?.controllerId === this.controllerId
      ) {
        await this.adopt(candidate.candidateId, `${candidate.displayName} (recovered)`);
      }
    }
  }

  /** Claims and registers the existing resources in place. No container, volume, config or secret is copied. */
  async adopt(candidateId: string, name: string): Promise<InstanceSummary> {
    const candidate = (await this.discover()).find((item) => item.candidateId === candidateId);
    if (!candidate) throw new Error(`discovery candidate not found: ${candidateId}`);
    const alreadyRegistered = this.store.listInstances().some((row) => row.externalInstanceId === candidate.instanceId);
    if (alreadyRegistered) throw new Error("instance is already registered in this hub");
    const ownedByThisHub = candidate.controller?.controllerId === this.controllerId;
    if (candidate.status !== "ready" && !(candidate.status === "already-claimed" && ownedByThisHub)) {
      throw new Error(`candidate cannot be adopted (${candidate.status}): ${candidate.issues.join("; ") || "preflight failed"}`);
    }

    const adapter = getContractAdapter(candidate.managerId);
    const claim = await adapter.claim(candidate, this.controllerId);
    const manifest = validateRuntimeManifest(claim.manifest);
    const id = randomUUID();
    const slug = makeSlug(name);
    try {
      const ports = manifest.resources.ports;
      const names = manifest.resources.containers;
      const [apiStatus, frontendStatus] = await Promise.all([
        podman.containerStatus(names.api),
        podman.containerStatus(names.frontend),
      ]);
      this.store.insertInstance({
        id,
        slug,
        gameType: manifest.gameType,
        name,
        lifecycle: "created",
        ports: JSON.stringify(ports),
        errorMessage: null,
        memoryMb: 0,
        diskGb: 0,
        mock: false,
        desiredState: apiStatus === "running" && frontendStatus === "running" ? "running" : "stopped",
        imageCommitApi: null,
        imageCommitFrontend: null,
        origin: "adopted",
        managerId: manifest.managerId,
        externalInstanceId: manifest.instanceId,
        contractVersion: manifest.contractVersion,
        driverRef: JSON.stringify(manifest.driver.command),
        resourceManifest: JSON.stringify(manifest),
        controllerRevision: claim.controller.revision,
      });
    } catch (error) {
      if (!ownedByThisHub) {
        await adapter.release(manifest, this.controllerId, claim.controller.revision).catch(() => undefined);
      }
      throw error;
    }

    this.store.insertMaintenanceLog({
      scope: "instance",
      instanceId: id,
      gameType: manifest.gameType,
      action: "adopt-in-place",
      detail: `claimed existing instance ${manifest.instanceId}; no runtime resources were copied or renamed`,
      success: true,
    });
    return this.toSummaryWithLiveStatus(this.store.getInstance(id)!);
  }

  /** Releases exclusive ownership and forgets an adopted instance without touching runtime resources. */
  async detach(id: string): Promise<void> {
    const row = this.requireRow(id);
    if (row.origin !== "adopted") throw new Error("only an adopted instance can be detached");
    const manifest = this.requireRuntimeManifest(row);
    const revision = row.controllerRevision;
    if (revision === null || !row.managerId) throw new Error("adopted instance is missing controller metadata");
    await getContractAdapter(row.managerId).release(manifest, this.controllerId, revision);
    this.store.insertMaintenanceLog({
      scope: "instance",
      instanceId: id,
      gameType: row.gameType,
      action: "detach",
      detail: `released ${manifest.instanceId}; containers, volumes, config and secrets left unchanged`,
      success: true,
    });
    this.store.deleteInstance(id);
  }

  private async provisionInstance(
    gameType: GameType,
    name: string,
    mock: boolean,
    memoryMb: number,
    diskGb: number,
  ): Promise<CreateInstanceResult> {
    const template = getLegacyTemplateAdapter(gameType).template;
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
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await chmod(configDir, 0o700);
      await writeFile(path.join(configDir, "manager.toml"), template.renderConfigToml(ctx, ports), "utf-8");
      const secrets = template.generateSecrets(ctx);
      const secretsPath = path.join(configDir, "manager.secrets.toml");
      await writeFile(secretsPath, secrets.content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      await chmod(secretsPath, 0o600);

      await this.ensureImages(template);
      if (template.secretName) await podman.secretCreate(template.secretName(slug), secretsPath);
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
    // One podman spawn for every instance's status, not two per instance —
    // this is the dashboard's 5s poll, so that difference is N podman
    // child processes every tick vs. exactly 1, regardless of N.
    const statuses = await podman.containerStatuses();
    return Promise.all(rows.map((row) => this.toSummaryWithLiveStatus(row, statuses)));
  }

  async get(id: string): Promise<InstanceSummary | undefined> {
    const row = this.store.getInstance(id);
    return row ? this.toSummaryWithLiveStatus(row) : undefined;
  }

  async getCredentials(id: string): Promise<InstanceCredentials> {
    const row = this.requireRow(id);
    if (row.origin === "adopted") {
      throw new Error("adopted instances keep manager-owned secrets; rotate credentials through the manager instead");
    }
    const secretsPath = path.join(this.instanceDir(row.slug), "config", "manager.secrets.toml");
    const raw = await readFile(secretsPath, "utf-8");
    const parsed = TOML.parse(raw) as { web?: { password?: unknown } };
    const password = typeof parsed.web?.password === "string" ? parsed.web.password : "";
    return { username: "admin", password };
  }

  async start(id: string): Promise<void> {
    const row = this.requireRow(id);
    if (row.origin === "adopted") {
      await this.adoptedLifecycle(row, "start");
    } else if (row.pendingRecreate) {
      await this.swapToLatestImage(row);
    } else {
      const template = getLegacyTemplateAdapter(row.gameType).template;
      const names = template.containerNames(row.slug);
      await podman.start(names.api);
      await podman.start(names.frontend);
    }
    this.store.setDesiredState(id, "running");
    this.store.resetCrashRestartCount(id);
  }

  async stop(id: string): Promise<void> {
    const row = this.requireRow(id);
    this.store.setDesiredState(id, "stopped");
    if (row.origin === "adopted") {
      await this.adoptedLifecycle(row, "stop");
    } else {
      const names = this.containerNames(row);
      await podman.stop(names.frontend);
      await podman.stop(names.api);
    }
  }

  async restart(id: string): Promise<void> {
    const row = this.requireRow(id);
    if (row.origin === "adopted") {
      await this.adoptedLifecycle(row, "restart");
    } else if (row.pendingRecreate) {
      await this.swapToLatestImage(row);
    } else {
      const template = getLegacyTemplateAdapter(row.gameType).template;
      const names = template.containerNames(row.slug);
      await podman.restart(names.api);
      await podman.restart(names.frontend);
    }
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
    if (row.origin === "adopted") {
      await this.adoptedLifecycle(row, "restart");
    } else if (row.pendingRecreate) {
      await this.swapToLatestImage(row);
    } else {
      const template = getLegacyTemplateAdapter(row.gameType).template;
      const names = template.containerNames(row.slug);
      await podman.restart(names.api);
      await podman.restart(names.frontend);
    }
  }

  /** Whether both of an instance's containers are currently running. */
  async isRunning(row: InstanceRow): Promise<boolean> {
    const names = this.containerNames(row);
    const [apiStatus, frontendStatus] = await Promise.all([
      podman.containerStatus(names.api),
      podman.containerStatus(names.frontend),
    ]);
    return apiStatus === "running" && frontendStatus === "running";
  }

  /**
   * Swaps the containers onto whatever image currently carries the game's
   * tag (e.g. after rebuildImages), instead of reusing the original
   * container's image. Requested via "Recreate from latest image": if the
   * instance is currently running, the swap is deferred (pendingRecreate)
   * instead of applied here, so it doesn't cut off connected players —
   * start()/restart()/restartForRecovery() apply it automatically the next
   * time the instance actually comes back up.
   */
  async recreate(id: string): Promise<void> {
    const row = this.requireRow(id);
    if (row.origin === "adopted") {
      throw new Error("adopted instance updates must be performed by its manager driver");
    }

    if (await this.isRunning(row)) {
      this.store.setPendingRecreate(id, true);
      this.store.insertMaintenanceLog({
        scope: "instance",
        instanceId: id,
        gameType: row.gameType,
        action: "recreate-queued",
        detail: `${row.gameType} instance is running — will swap to the latest image next time it stops or restarts`,
        success: true,
      });
      return;
    }

    await this.swapToLatestImage(row);
    // recreate() always brings the containers back up (podman.run), so
    // desiredState must reflect that — otherwise an instance that was
    // deliberately stopped ends up running-but-still-flagged-stopped, which
    // silently breaks auto-restart-on-crash for it afterwards (the
    // scheduler only acts on desiredState === "running").
    this.store.setDesiredState(id, "running");
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

  /** Low-level image swap shared by recreate() and the pendingRecreate catch-up in start()/restart()/restartForRecovery() — does not touch desiredState or crashRestartCount, since those two callers each own that decision differently. */
  private async swapToLatestImage(row: InstanceRow): Promise<void> {
    const template = getLegacyTemplateAdapter(row.gameType).template;
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
    this.store.setImageCommits(row.id, imageRecord?.apiCommit ?? null, imageRecord?.frontendCommit ?? null);
    this.store.setPendingRecreate(row.id, false);
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
    if (row.origin === "adopted") {
      throw new Error("adopted instance resources can only be changed through a declared manager-driver capability");
    }
    if (!Number.isInteger(memoryMb) || memoryMb < 512) {
      throw new Error("memoryMb must be at least 512");
    }
    if (!Number.isInteger(diskGb) || diskGb < 0) {
      throw new Error("diskGb must be 0 (unlimited) or greater");
    }

    const names = this.containerNames(row);
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
    if (row.origin === "adopted") {
      await this.detach(id);
      return;
    }
    this.store.updateInstanceLifecycle(id, "deleting");
    const template = getLegacyTemplateAdapter(row.gameType).template;
    const names = template.containerNames(row.slug);

    await podman.removeContainer(names.frontend);
    await podman.removeContainer(names.api);
    await podman.networkRemove(template.networkName(row.slug));
    if (removeVolumes) {
      for (const volume of template.volumes(row.slug)) {
        await podman.volumeRemove(volume.name);
      }
    }
    if (template.secretName) await podman.secretRemove(template.secretName(row.slug));
    await rm(this.instanceDir(row.slug), { recursive: true, force: true });
    this.store.deleteInstance(id);
  }

  private acquireGameOperation(gameType: GameType, kind: "pull" | "rebuild"): void {
    const active = this.activeGameOperations.get(gameType);
    if (active) {
      throw new Error(`a ${active} for ${gameType} is already in progress — wait for it to finish first`);
    }
    this.activeGameOperations.set(gameType, kind);
  }

  /** Builds both images for a game type unconditionally (unlike ensureImages, which skips if the tag already exists) and records the source commit that produced them. */
  async rebuildImages(gameType: GameType): Promise<GameImagesRecord> {
    this.acquireGameOperation(gameType, "rebuild");
    try {
      const template = getLegacyTemplateAdapter(gameType).template;
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
      this.activeGameOperations.delete(gameType);
    }
  }

  /** Pulls the latest commits for a game's sibling repo (--ff-only — never merges/rebases). Does NOT rebuild automatically; the image-status commit comparison will simply show the game as having a newer source commit than what's built, same as any other upstream change. */
  async pullLatest(gameType: GameType): Promise<{ success: boolean; message: string }> {
    this.acquireGameOperation(gameType, "pull");
    try {
      const template = getLegacyTemplateAdapter(gameType).template;
      const contextDir = path.join(this.reposRoot, template.repoDirName);
      const result = await pull(contextDir);
      this.store.insertMaintenanceLog({
        scope: "image",
        instanceId: null,
        gameType,
        action: "git-pull",
        detail: result.message,
        success: result.success,
      });
      return result;
    } finally {
      this.activeGameOperations.delete(gameType);
    }
  }

  /** Whether a rebuild for this game type is currently running, so the UI can show a persistent "in progress" state across page reloads instead of relying on local button state alone. */
  isRebuilding(gameType: GameType): boolean {
    return this.activeGameOperations.get(gameType) === "rebuild";
  }

  /** Same idea as isRebuilding(), for a git pull in progress. */
  isPulling(gameType: GameType): boolean {
    return this.activeGameOperations.get(gameType) === "pull";
  }

  /** Live comparison of each game's current source commit against what every existing instance was built from — no periodic job needed, this is cheap enough to compute on demand. */
  async imageStatus(): Promise<GameImageStatus[]> {
    const rows = this.store.listInstances();
    return Promise.all(
      listLegacyTemplateAdapters().map(async ({ template }) => {
        const contextDir = path.join(this.reposRoot, template.repoDirName);
        const currentCommit = await getHeadCommit(contextDir);
        const record = this.store.getJson<GameImagesRecord>(gameImagesKey(template.gameType));
        const outdatedInstances = rows
          .filter(
            (row) =>
              row.gameType === template.gameType &&
              row.origin !== "adopted" &&
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
          pulling: this.isPulling(template.gameType),
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
    const names = this.containerNames(row);
    const stats = await podman.containerStats(names.api);
    const sizeableVolumes = row.origin === "adopted"
      ? this.requireRuntimeManifest(row).resources.sizeableVolumes ?? []
      : getLegacyTemplateAdapter(row.gameType).template.volumes(row.slug).filter((volume) => volume.sizeable).map((volume) => volume.name);
    const diskUsedBytes = sizeableVolumes.reduce((sum, volume) => sum + (volumeUsage.get(volume) ?? 0), 0);

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

  private requireRuntimeManifest(row: InstanceRow): RuntimeInstanceManifest {
    if (!row.resourceManifest) throw new Error(`instance ${row.id} has no runtime manifest`);
    return validateRuntimeManifest(JSON.parse(row.resourceManifest));
  }

  private containerNames(row: InstanceRow): { api: string; frontend: string } {
    if (row.origin === "adopted") {
      const containers = this.requireRuntimeManifest(row).resources.containers;
      return { api: containers.api, frontend: containers.frontend };
    }
    return getLegacyTemplateAdapter(row.gameType).template.containerNames(row.slug);
  }

  private async adoptedLifecycle(row: InstanceRow, action: "start" | "stop" | "restart"): Promise<void> {
    if (!row.managerId || row.controllerRevision === null) {
      throw new Error("adopted instance is missing controller metadata");
    }
    await getContractAdapter(row.managerId).lifecycle(
      this.requireRuntimeManifest(row),
      this.controllerId,
      row.controllerRevision,
      action,
    );
  }

  private toSummary(row: InstanceRow): InstanceSummary {
    const ports = JSON.parse(row.ports) as PortMap;
    const manifest = row.origin === "adopted" ? this.requireRuntimeManifest(row) : null;
    const template = manifest ? null : getLegacyTemplateAdapter(row.gameType).template;
    return {
      id: row.id,
      slug: row.slug,
      gameType: row.gameType,
      gameDisplayName: manifest?.displayName ?? template!.displayName,
      name: row.name,
      lifecycle: row.lifecycle,
      errorMessage: row.errorMessage,
      status: row.lifecycle === "created" ? "stopped" : row.lifecycle,
      ports,
      panelUrl: manifest ? `http://127.0.0.1:${ports.web}` : template!.panelUrl(ports),
      createdAt: row.createdAt,
      memoryMb: row.memoryMb,
      diskGb: row.diskGb,
      desiredState: row.desiredState,
      restartSchedule: row.restartSchedule,
      crashRestartCount: row.crashRestartCount,
      pendingRecreate: row.pendingRecreate,
      origin: row.origin,
      credentialsMode: row.origin === "adopted" ? "manager-owned" : "recoverable-legacy",
    };
  }

  /** statuses: pass a pre-fetched map (e.g. from list(), which fetches it once for every row) to avoid this doing its own extra podman round-trip; omit it for a one-off single-instance lookup. */
  private async toSummaryWithLiveStatus(
    row: InstanceRow,
    statuses?: Map<string, podman.ContainerStatus>,
  ): Promise<InstanceSummary> {
    const summary = this.toSummary(row);
    if (row.lifecycle !== "created") return summary;

    const names = this.containerNames(row);
    const resolved = statuses ?? (await podman.containerStatuses());
    const apiStatus = resolved.get(names.api) ?? "missing";
    const frontendStatus = resolved.get(names.frontend) ?? "missing";

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
