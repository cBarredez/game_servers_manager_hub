import type { GameType } from "../infra/sqliteStore.js";

/** Per-instance port values, keyed by logical name (game-specific). Stored as JSON in the DB. */
export type PortMap = Record<string, number>;

export interface GeneratedSecrets {
  /** manager.secrets.toml content for the instance. */
  content: string;
  /** Plaintext initial panel password, shown to the user once at creation time. */
  initialPassword: string;
}

export interface InstanceContext {
  id: string;
  slug: string;
  name: string;
  mock: boolean;
  /** Absolute host path to this instance's generated config directory. */
  configDir: string;
  /** Container memory limit in MB, applied to the api container's --memory flag. */
  memoryMb: number;
  /** Requested disk allocation in GB for this instance's main data volume(s), 0 = unlimited.
   *  Best-effort only: enforced via a volume size option where the host's storage
   *  backend supports project quotas, silently unenforced otherwise (see infra/podman.ts). */
  diskGb: number;
}

export interface ContainerNames {
  api: string;
  frontend: string;
}

export interface VolumeSpec {
  name: string;
  /** Whether this volume is a candidate for the instance's disk-size request (the volume that actually holds game/save data, as opposed to small auxiliary volumes like Steam credentials). */
  sizeable: boolean;
}

/**
 * Describes how to provision N independent copies of an existing single-instance
 * game manager stack (arma_server, proyect_zomboid, ...). Every method is a pure
 * function of (instance id/slug/index) so the same template run twice for the
 * same instance always produces the same names/ports/config.
 */
export interface GameTemplate {
  gameType: GameType;
  displayName: string;
  /** Directory name of the sibling repo used as the Podman build context. */
  repoDirName: string;
  images: { api: string; frontend: string };
  /** Sensible default container memory limit (MB), pre-filled in the "new instance" form. */
  defaultMemoryMb: number;

  /** Deterministic port block for the Nth instance of this game type (0-based), folding in the shared web port. */
  allocatePorts(index: number, webPort: number): PortMap;

  containerNames(slug: string): ContainerNames;
  networkName(slug: string): string;
  volumes(slug: string): VolumeSpec[];
  /** Optional manager-owned Podman secret used instead of bind-mounting secret files. */
  secretName?(slug: string): string;

  /** The subset of a PortMap that actually gets published on the host and must be checked for collisions before use. */
  portsToCheck(ports: PortMap): { port: number; protocol: "tcp" | "udp" }[];

  renderConfigToml(ctx: InstanceContext, ports: PortMap): string;
  generateSecrets(ctx: InstanceContext): GeneratedSecrets;

  /** podman run args for the api container, excluding `run -d --replace` and the image tag. */
  apiRunArgs(ctx: InstanceContext, ports: PortMap): string[];
  /** podman run args for the frontend container, excluding `run -d --replace` and the image tag. */
  frontendRunArgs(ctx: InstanceContext, ports: PortMap): string[];

  /** URL where the instance's own panel becomes reachable once running. */
  panelUrl(ports: PortMap): string;
}
