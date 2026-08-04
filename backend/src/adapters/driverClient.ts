import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { realpath, readdir, readFile } from "node:fs/promises";
import type { DiscoveryCandidate, DriverClaim, RuntimeInstanceManifest } from "./types.js";

const INSTANCE_ID = /^[a-f0-9]{32}$/;
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9-]+$/;
const SECRET_KEY = /password|token|secret(?!s$)|privateKey|credential/i;
const REQUIRED_ADOPTION_CAPABILITIES = ["discover", "adopt", "lifecycle", "health", "detach"] as const;

export class DriverProtocolError extends Error {
  constructor(message: string, public readonly code = "driver_error") {
    super(message);
  }
}

export function runtimeRegistryDir(): string {
  return process.env.GSM_STATE_ROOT
    ? path.resolve(process.env.GSM_STATE_ROOT, "instances")
    : path.join(homedir(), ".local", "share", "game-server-managers", "instances");
}

function armaDriverRoot(): string {
  return process.env.ARMA3_DRIVER_ROOT
    ? path.resolve(process.env.ARMA3_DRIVER_ROOT)
    : path.join(homedir(), ".local", "share", "arma3-manager", "releases");
}

async function assertTrustedArmaDriver(command: string[]): Promise<void> {
  if (
    !path.isAbsolute(command[0]) ||
    !path.isAbsolute(command[1]) ||
    !/^python3(?:\.\d+)?$/.test(path.basename(command[0])) ||
    path.basename(command[1]) !== "manager_driver.py"
  ) {
    throw new DriverProtocolError("Arma driver command must use absolute Python/script paths", "incompatible");
  }
  const [root, script] = await Promise.all([realpath(armaDriverRoot()), realpath(command[1])]);
  const relative = path.relative(root, script);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new DriverProtocolError("Arma driver script is outside the trusted release root", "incompatible");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsSecretValue(value: unknown, key = ""): boolean {
  if (SECRET_KEY.test(key)) return true;
  if (Array.isArray(value)) return value.some((item) => containsSecretValue(item));
  if (object(value)) return Object.entries(value).some(([childKey, child]) => containsSecretValue(child, childKey));
  return false;
}

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0 && !item.includes("\0"));
}

function stringRecord(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every((item) => typeof item === "string" && item.length > 0);
}

export function validateRuntimeManifest(value: unknown): RuntimeInstanceManifest {
  if (!object(value)) throw new DriverProtocolError("runtime manifest must be an object", "invalid_manifest");
  if (value.contractVersion !== "1.0") throw new DriverProtocolError("unsupported contractVersion", "incompatible");
  if (typeof value.instanceId !== "string" || !INSTANCE_ID.test(value.instanceId)) {
    throw new DriverProtocolError("invalid instanceId", "invalid_manifest");
  }
  if (typeof value.managerId !== "string" || !SAFE_IDENTIFIER.test(value.managerId)) {
    throw new DriverProtocolError("invalid managerId", "invalid_manifest");
  }
  if (typeof value.gameType !== "string" || !SAFE_IDENTIFIER.test(value.gameType)) {
    throw new DriverProtocolError("invalid gameType", "invalid_manifest");
  }
  if (typeof value.displayName !== "string" || !value.displayName.trim()) {
    throw new DriverProtocolError("displayName is required", "invalid_manifest");
  }
  if (!object(value.driver) || value.driver.protocolVersion !== "1.0" || !Array.isArray(value.driver.command)) {
    throw new DriverProtocolError("invalid driver declaration", "invalid_manifest");
  }
  const command = value.driver.command;
  if (command.length < 2 || !nonEmptyStrings(command)) {
    throw new DriverProtocolError("driver command must contain executable and script", "invalid_manifest");
  }
  if (!object(value.resources) || !object(value.resources.containers) || !object(value.resources.ports)) {
    throw new DriverProtocolError("resources.containers and resources.ports are required", "invalid_manifest");
  }
  if (
    !stringRecord(value.resources.containers) ||
    typeof value.resources.containers.api !== "string" ||
    typeof value.resources.containers.frontend !== "string"
  ) {
    throw new DriverProtocolError("api and frontend container roles are required", "invalid_manifest");
  }
  if (!nonEmptyStrings(value.resources.volumes) || !nonEmptyStrings(value.resources.networks)) {
    throw new DriverProtocolError("volume and network lists are required", "invalid_manifest");
  }
  if (
    !object(value.resources.ports) ||
    !Number.isInteger(value.resources.ports.web) ||
    Object.values(value.resources.ports).some((port) => !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535)
  ) {
    throw new DriverProtocolError("ports.web and all ports must be integers from 1 through 65535", "invalid_manifest");
  }
  if (
    !nonEmptyStrings(value.capabilities) ||
    new Set(value.capabilities).size !== value.capabilities.length ||
    !stringRecord(value.images) ||
    typeof value.images.api !== "string" ||
    typeof value.images.frontend !== "string" ||
    !object(value.config) ||
    !Array.isArray(value.secrets)
  ) {
    throw new DriverProtocolError("capabilities, images, config and secrets are required", "invalid_manifest");
  }
  if (
    value.secrets.some(
      (secret) =>
        !object(secret) ||
        typeof secret.id !== "string" ||
        !secret.id ||
        secret.provider !== "podman" ||
        typeof secret.reference !== "string" ||
        !secret.reference,
    )
  ) {
    throw new DriverProtocolError("secrets must contain Podman references only", "invalid_manifest");
  }
  if (!object(value.health)) {
    throw new DriverProtocolError("health declaration is required", "invalid_manifest");
  }
  if (!Number.isInteger(value.controllerRevision) || Number(value.controllerRevision) < 0) {
    throw new DriverProtocolError("controllerRevision must be a non-negative integer", "invalid_manifest");
  }
  if (containsSecretValue(value)) {
    throw new DriverProtocolError("runtime manifest contains a forbidden secret-bearing field", "invalid_manifest");
  }
  return value as unknown as RuntimeInstanceManifest;
}

export async function invokeDriver<T>(manifest: RuntimeInstanceManifest, command: string, request: object = {}): Promise<T> {
  const [executable, ...baseArgs] = manifest.driver.command;
  try {
    const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      const child = spawn(executable, [...baseArgs, command], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new DriverProtocolError(`driver command timed out: ${command}`, "timeout"));
      }, 120_000);
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 4 * 1024 * 1024) child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 4 * 1024 * 1024) child.kill("SIGKILL");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
      child.stdin.end(JSON.stringify(request));
    });
    if (exitCode !== 0) {
      const failure = new Error(`driver exited with code ${exitCode}`) as Error & { stderr?: string };
      failure.stderr = stderr;
      throw failure;
    }
    const value = JSON.parse(stdout) as T;
    return value;
  } catch (error) {
    const err = error as { stderr?: string; message: string };
    let code = "driver_error";
    let message = err.stderr?.trim() || err.message;
    try {
      const parsed = JSON.parse(err.stderr ?? "") as { error?: { code?: string; message?: string } };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? message;
    } catch {
      // stderr is allowed to be a plain diagnostic when the driver itself cannot start.
    }
    throw new DriverProtocolError(message, code);
  }
}

export async function loadRegisteredManifests(): Promise<RuntimeInstanceManifest[]> {
  let entries: string[];
  try {
    entries = await readdir(runtimeRegistryDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const manifests: RuntimeInstanceManifest[] = [];
  for (const entry of entries) {
    if (!INSTANCE_ID.test(entry)) continue;
    try {
      const raw = await readFile(path.join(runtimeRegistryDir(), entry, "instance.json"), "utf-8");
      manifests.push(validateRuntimeManifest(JSON.parse(raw)));
    } catch {
      // Invalid/unreadable entries are not candidates. The adapter reports
      // driver-level incompatibilities for valid manifests returned by discover.
    }
  }
  return manifests;
}

export async function discoverArma3(): Promise<DiscoveryCandidate[]> {
  const manifests = (await loadRegisteredManifests()).filter((manifest) => manifest.managerId === "arma3-server-manager");
  const candidates: DiscoveryCandidate[] = [];
  for (const manifest of manifests) {
    try {
      await assertTrustedArmaDriver(manifest.driver.command);
      const result = await invokeDriver<{ candidates: unknown[] }>(manifest, "discover");
      const match = result.candidates.find(
        (candidate) => object(candidate) && candidate.instanceId === manifest.instanceId,
      );
      if (!object(match)) continue;
      const validated = validateRuntimeManifest(match.manifest);
      const missingCapabilities = REQUIRED_ADOPTION_CAPABILITIES.filter(
        (capability) => !validated.capabilities.includes(capability),
      );
      if (missingCapabilities.length > 0) {
        throw new DriverProtocolError(
          `ARMA driver is missing adoption capabilities: ${missingCapabilities.join(", ")}`,
          "incompatible",
        );
      }
      const status = match.status;
      if (!["ready", "incompatible", "partial", "conflict", "already-claimed"].includes(String(status))) continue;
      candidates.push({
        candidateId: validated.instanceId,
        instanceId: validated.instanceId,
        managerId: validated.managerId,
        gameType: validated.gameType,
        displayName: validated.displayName,
        status: status as DiscoveryCandidate["status"],
        issues: Array.isArray(match.issues) ? match.issues.filter((issue): issue is string => typeof issue === "string") : [],
        controller: object(match.controller)
          ? {
              controllerId: String(match.controller.controllerId),
              revision: Number(match.controller.revision),
              claimedAt: String(match.controller.claimedAt),
            }
          : null,
        manifest: validated,
      });
    } catch (error) {
      candidates.push({
        candidateId: manifest.instanceId,
        instanceId: manifest.instanceId,
        managerId: manifest.managerId,
        gameType: manifest.gameType,
        displayName: manifest.displayName,
        status: error instanceof DriverProtocolError && error.code === "already_claimed" ? "already-claimed" : "incompatible",
        issues: [error instanceof Error ? error.message : String(error)],
        controller: null,
        manifest,
      });
    }
  }
  return candidates;
}

export async function claimDriver(manifest: RuntimeInstanceManifest, controllerId: string): Promise<DriverClaim> {
  return invokeDriver<DriverClaim>(manifest, "claim", {
    instanceId: manifest.instanceId,
    controllerId,
    expectedRevision: manifest.controllerRevision,
  });
}

export async function releaseDriver(manifest: RuntimeInstanceManifest, controllerId: string, revision: number): Promise<void> {
  await invokeDriver(manifest, "release", { instanceId: manifest.instanceId, controllerId, revision });
}

export async function lifecycleDriver(
  manifest: RuntimeInstanceManifest,
  controllerId: string,
  revision: number,
  action: "start" | "stop" | "restart",
): Promise<void> {
  await invokeDriver(manifest, action, { instanceId: manifest.instanceId, controllerId, revision });
}
