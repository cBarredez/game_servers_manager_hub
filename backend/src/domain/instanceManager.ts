import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as TOML from "smol-toml";
import type { GameType, InstanceRow } from "../infra/sqliteStore.js";
import { SqliteStore } from "../infra/sqliteStore.js";
import { PortAllocator } from "../infra/portAllocator.js";
import * as podman from "../infra/podman.js";
import { allPortsFree } from "../infra/portCheck.js";
import { getTemplate } from "../templates/index.js";
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

export class InstanceManager {
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

    this.store.insertInstance({
      id,
      slug,
      gameType,
      name,
      lifecycle: "creating",
      ports: JSON.stringify(ports),
      errorMessage: null,
    });

    const configDir = path.join(this.instanceDir(slug), "config");
    const ctx = { id, slug, name, mock, configDir, memoryMb, diskGb };

    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, "manager.toml"), template.renderConfigToml(ctx, ports), "utf-8");
      const secrets = template.generateSecrets(ctx);
      await writeFile(path.join(configDir, "manager.secrets.toml"), secrets.content, "utf-8");

      await this.ensureImages(template);

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
  }

  async stop(id: string): Promise<void> {
    const row = this.requireRow(id);
    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);
    await podman.stop(names.frontend);
    await podman.stop(names.api);
  }

  async restart(id: string): Promise<void> {
    const row = this.requireRow(id);
    const template = getTemplate(row.gameType);
    const names = template.containerNames(row.slug);
    await podman.restart(names.api);
    await podman.restart(names.frontend);
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

  private async ensureImages(template: GameTemplate): Promise<void> {
    const contextDir = path.join(this.reposRoot, template.repoDirName);
    if (!(await podman.imageExists(template.images.api))) {
      await podman.build(contextDir, path.join(contextDir, "Containerfile.api"), template.images.api);
    }
    if (!(await podman.imageExists(template.images.frontend))) {
      await podman.build(contextDir, path.join(contextDir, "Containerfile.frontend"), template.images.frontend);
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
