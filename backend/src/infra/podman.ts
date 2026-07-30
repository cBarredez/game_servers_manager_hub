import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class PodmanError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string,
  ) {
    super(message);
  }
}

/**
 * Thin wrapper around the `podman` CLI. Always invoked as execFile with an
 * argv array (never a shell string), so instance names/paths can never be
 * interpreted as shell syntax.
 */
export async function podman(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("podman", args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const err = error as { stderr?: string; message: string };
    throw new PodmanError(`podman ${args[0]} failed: ${err.stderr?.trim() || err.message}`, args, err.stderr ?? "");
  }
}

/** Runs a podman command, swallowing failure — for idempotent create/remove calls. */
export async function podmanBestEffort(args: string[]): Promise<void> {
  try {
    await podman(args);
  } catch {
    // idempotent operations (e.g. "already exists", "no such container") are expected
  }
}

export async function networkCreate(name: string): Promise<void> {
  await podmanBestEffort(["network", "create", name]);
}

export async function networkRemove(name: string): Promise<void> {
  await podmanBestEffort(["network", "rm", name]);
}

export async function volumeCreate(name: string): Promise<void> {
  await podmanBestEffort(["volume", "create", name]);
}

/**
 * Creates a volume with a best-effort size cap (via the local driver's
 * project-quota option). Most Podman storage backends do NOT support this
 * (it needs an XFS-backed store with project quotas enabled) — when the
 * option is rejected, this transparently falls back to an unlimited volume
 * instead of failing instance creation. Returns whether the size limit was
 * actually applied, so callers can report the real outcome instead of
 * assuming it worked.
 */
export async function volumeCreateSized(name: string, sizeGb: number): Promise<boolean> {
  try {
    await podman(["volume", "create", "--opt", `o=size=${sizeGb}G`, name]);
    return true;
  } catch {
    await volumeCreate(name);
    return false;
  }
}

export async function volumeRemove(name: string): Promise<void> {
  await podmanBestEffort(["volume", "rm", name]);
}

export async function imageExists(tag: string): Promise<boolean> {
  try {
    await podman(["image", "exists", tag]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes dangling (untagged) images and returns the IDs removed, so callers
 * can report a meaningful count instead of a silent best-effort call.
 */
export async function pruneDangling(): Promise<string[]> {
  try {
    const output = await podman(["image", "prune", "-f"]);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function build(contextDir: string, containerfile: string, tag: string): Promise<void> {
  await podman(["build", "--file", containerfile, "--tag", tag, contextDir]);
  // Multi-stage Containerfiles (both arma3 and pz use them) leave the
  // intermediate build-stage image dangling (untagged) after each build —
  // harmless but it silently eats disk space over time, so sweep it up
  // immediately rather than letting it accumulate across future rebuilds.
  await pruneDangling();
}

export async function run(args: string[]): Promise<void> {
  await podman(["run", "-d", "--replace", ...args]);
}

export async function stop(containerName: string): Promise<void> {
  await podmanBestEffort(["stop", containerName]);
}

export async function start(containerName: string): Promise<void> {
  await podman(["start", containerName]);
}

export async function restart(containerName: string): Promise<void> {
  await podman(["restart", containerName]);
}

export async function removeContainer(containerName: string): Promise<void> {
  await podmanBestEffort(["rm", "-f", containerName]);
}

/** Changes a container's memory limit live — takes effect immediately, no restart needed, whether the container is running or stopped. Returns false instead of throwing if the container doesn't exist (e.g. an instance whose api container was manually removed). */
export async function updateMemory(containerName: string, memoryMb: number): Promise<boolean> {
  try {
    await podman(["update", "--memory", `${memoryMb}m`, containerName]);
    return true;
  } catch {
    return false;
  }
}

export type ContainerStatus = "running" | "stopped" | "missing";

export async function containerStatus(containerName: string): Promise<ContainerStatus> {
  try {
    const state = await podman(["inspect", "--format", "{{.State.Status}}", containerName]);
    return state === "running" ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

/** Parses a podman-formatted size like "516.1kB", "14.65GB", or "1.784MiB" into raw bytes. */
export function parseByteSize(text: string): number {
  const match = /^([\d.]+)\s*([a-zA-Z]*)$/.exec(text.trim());
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  const multipliers: Record<string, number> = {
    "": 1,
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  return value * (multipliers[match[2].toLowerCase()] ?? 1);
}

export interface ContainerStats {
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
}

/** Live CPU/RAM for a single running container. Returns null for a stopped/missing container — podman stats only works on running ones. */
export async function containerStats(containerName: string): Promise<ContainerStats | null> {
  try {
    const output = await podman(["stats", "--no-stream", "--format", "json", containerName]);
    const [entry] = JSON.parse(output) as { cpu_percent?: string; mem_usage?: string }[];
    if (!entry?.mem_usage) return null;
    const [usedText, limitText] = entry.mem_usage.split("/").map((part) => part.trim());
    return {
      cpuPercent: Number.parseFloat((entry.cpu_percent ?? "0").replace("%", "")) || 0,
      memUsedBytes: parseByteSize(usedText ?? "0"),
      memLimitBytes: parseByteSize(limitText ?? "0"),
    };
  } catch {
    return null;
  }
}

/** Disk usage of every local volume, keyed by volume name, parsed from `podman system df -v`'s "Local Volumes" table (podman has no JSON output for this). */
export async function volumeDiskUsage(): Promise<Map<string, number>> {
  const usage = new Map<string, number>();
  try {
    const output = await podman(["system", "df", "-v"]);
    const lines = output.split("\n");
    const headerIndex = lines.findIndex((line) => line.trim().startsWith("VOLUME NAME"));
    if (headerIndex === -1) return usage;
    for (const line of lines.slice(headerIndex + 1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 2) continue;
      usage.set(columns[0], parseByteSize(columns[columns.length - 1]));
    }
  } catch {
    // best-effort — an empty map just means the UI shows no disk figure
  }
  return usage;
}
