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

export interface PullResult {
  success: boolean;
  /** Raw git output (or the error message) — surfaced to the UI as-is so a merge conflict or diverged-branch failure is actually readable, not swallowed. */
  message: string;
}

/**
 * Pulls the latest commits for a sibling repo. Uses --ff-only deliberately:
 * a hub button is not the place to auto-create a merge commit or attempt a
 * rebase — if the local branch has diverged (e.g. someone edited the repo
 * directly on this host), this fails cleanly with git's own explanation
 * instead of silently merging or conflicting.
 */
export async function pull(repoDir: string): Promise<PullResult> {
  try {
    // --no-edit/-q keep it non-interactive; a hard timeout guarantees this
    // can never hang the hub process indefinitely regardless of the cause
    // (e.g. a credential prompt on a misconfigured remote).
    const { stdout, stderr } = await execFileAsync("git", ["-C", repoDir, "pull", "--ff-only", "-q"], {
      timeout: 20_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { success: true, message: (stdout || stderr || "already up to date").trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string; killed?: boolean };
    const message = err.killed ? "git pull timed out after 20s" : err.stderr || err.stdout || err.message;
    return { success: false, message: message.trim() };
  }
}
