import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// On Windows npm is a .cmd shim, not a directly-executable binary; execFile
// resolves it fine as long as the .cmd extension is spelled out.
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

export async function npmInstall(cwd: string): Promise<void> {
  await execFileAsync(NPM_BIN, ["install"], { cwd, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
}

export async function npmRun(cwd: string, script: string): Promise<void> {
  await execFileAsync(NPM_BIN, ["run", script], { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}
