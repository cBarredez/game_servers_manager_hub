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

export async function build(contextDir: string, containerfile: string, tag: string): Promise<void> {
  await podman(["build", "--file", containerfile, "--tag", tag, contextDir]);
  // Multi-stage Containerfiles (both arma3 and pz use them) leave the
  // intermediate build-stage image dangling (untagged) after each build —
  // harmless but it silently eats disk space over time, so sweep it up
  // immediately rather than letting it accumulate across future rebuilds.
  await podmanBestEffort(["image", "prune", "-f"]);
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

export type ContainerStatus = "running" | "stopped" | "missing";

export async function containerStatus(containerName: string): Promise<ContainerStatus> {
  try {
    const state = await podman(["inspect", "--format", "{{.State.Status}}", containerName]);
    return state === "running" ? "running" : "stopped";
  } catch {
    return "missing";
  }
}
