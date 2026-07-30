import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Current commit hash of a sibling repo (arma_server/proyect_zomboid), used
 * to detect when an instance's image predates the latest source. Returns
 * null instead of throwing when the directory isn't a git repo (or git
 * isn't available) so image-update tracking degrades gracefully instead of
 * breaking instance creation.
 *
 * Limitation: only detects committed changes — uncommitted local edits to
 * either repo won't be picked up as "an update is available."
 */
export async function getHeadCommit(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
}
