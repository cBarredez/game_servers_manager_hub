import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync, openSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { SqliteStore } from "../infra/sqliteStore.js";
import { fetchRemote, getHeadCommit, getUpstreamCommit, pull } from "../infra/git.js";
import { npmInstall, npmRun } from "../infra/npm.js";

const execFileAsync = promisify(execFile);

export interface HubUpdateStatus {
  currentCommit: string | null;
  remoteCommit: string | null;
  updateAvailable: boolean;
  updating: boolean;
  checkError: string | null;
}

export interface HubUpdateResult {
  success: boolean;
  message: string;
  /** True once the hub has committed to restarting itself — the caller must not treat this response as "request finished" the normal way, since the process handling it is about to exit. */
  restarting: boolean;
}

/** True if any package.json/package-lock.json changed between two commits — the signal for whether `npm install` is worth the time, instead of running it unconditionally on every update. */
export function dependencyManifestsChanged(changedFiles: string[]): boolean {
  return changedFiles.some((file) => /(^|\/)package(-lock)?\.json$/.test(file));
}

/**
 * Lets the hub pull its own latest source, rebuild, and restart itself in
 * place — the hub runs as a plain `node` process with no supervisor, so
 * "restart" means: build the update while still serving traffic, then hand
 * off to a freshly-spawned detached process and exit. If anything before the
 * handoff fails (pull, install, build), the current process is left running
 * untouched — only a fully successful build commits to restarting.
 */
export class SelfUpdateService {
  private updating = false;

  constructor(
    private readonly store: SqliteStore,
    private readonly hubRoot: string,
  ) {}

  async getStatus(): Promise<HubUpdateStatus> {
    const currentCommit = await getHeadCommit(this.hubRoot);
    if (this.updating) {
      return { currentCommit, remoteCommit: null, updateAvailable: false, updating: true, checkError: null };
    }
    const fetchResult = await fetchRemote(this.hubRoot);
    if (!fetchResult.success) {
      return {
        currentCommit,
        remoteCommit: null,
        updateAvailable: false,
        updating: false,
        checkError: fetchResult.message ?? "git fetch failed",
      };
    }
    const remoteCommit = await getUpstreamCommit(this.hubRoot);
    const updateAvailable = remoteCommit !== null && currentCommit !== null && remoteCommit !== currentCommit;
    return { currentCommit, remoteCommit, updateAvailable, updating: false, checkError: null };
  }

  /** Pulls + rebuilds the hub itself. Never restarts on its own — call restart() only after a caller-controlled point (e.g. once an HTTP response has actually flushed) when result.restarting is true. */
  async update(): Promise<HubUpdateResult> {
    if (this.updating) {
      throw new Error("a hub update is already in progress — wait for it to finish first");
    }
    this.updating = true;
    try {
      const beforeCommit = await getHeadCommit(this.hubRoot);
      const pullResult = await pull(this.hubRoot);
      if (!pullResult.success) {
        this.log(pullResult.message, false);
        return { success: false, message: pullResult.message, restarting: false };
      }

      const afterCommit = await getHeadCommit(this.hubRoot);
      if (!afterCommit || beforeCommit === afterCommit) {
        this.log("already up to date", true);
        return { success: true, message: "Already up to date.", restarting: false };
      }

      const changed = beforeCommit ? await this.changedFiles(beforeCommit, afterCommit) : [];
      if (dependencyManifestsChanged(changed)) {
        await npmInstall(this.hubRoot);
      }
      await npmRun(this.hubRoot, "build:backend");
      await npmRun(this.hubRoot, "build:frontend");

      const distServer = path.join(this.hubRoot, "backend", "dist", "server.js");
      if (!existsSync(distServer)) {
        throw new Error("build succeeded but backend/dist/server.js is missing — aborting restart");
      }

      this.log(`updated to ${afterCommit.slice(0, 12)}, restarting`, true);
      return { success: true, message: `Updated to ${afterCommit.slice(0, 10)}. Restarting now…`, restarting: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(message, false);
      return { success: false, message, restarting: false };
    } finally {
      this.updating = false;
    }
  }

  /**
   * Hands off to a freshly-spawned, detached process running the just-built
   * code, then exits this one. There's no supervisor to restart the hub if
   * this goes wrong, so callers must only invoke this after a successful
   * update() (restarting: true) and after any HTTP response for the request
   * that triggered it has already been flushed to the client.
   */
  async restart(app: FastifyInstance): Promise<void> {
    await app.close().catch(() => {});
    this.store.close();

    const logFd = openSync(path.join(this.hubRoot, "data", "hub-selfupdate.log"), "a");
    const child = spawn(process.execPath, [path.join(this.hubRoot, "backend", "dist", "server.js")], {
      cwd: this.hubRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    process.exit(0);
  }

  private async changedFiles(before: string, after: string): Promise<string[]> {
    const { stdout } = await execFileAsync("git", ["-C", this.hubRoot, "diff", "--name-only", before, after]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private log(detail: string, success: boolean): void {
    this.store.insertMaintenanceLog({
      scope: "host",
      instanceId: null,
      gameType: null,
      action: "hub-update",
      detail,
      success,
    });
  }
}
