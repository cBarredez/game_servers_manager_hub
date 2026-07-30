import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getHeadCommit } from "./git.js";

const execFileAsync = promisify(execFile);

describe("getHeadCommit", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("returns the actual HEAD hash for a real git repo", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hub-git-test-"));
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(path.join(dir, "file.txt"), "hello");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });

    const { stdout: expected } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"]);

    expect(await getHeadCommit(dir)).toBe(expected.trim());
  });

  it("returns null for a directory that isn't a git repo", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hub-git-test-"));
    expect(await getHeadCommit(dir)).toBeNull();
  });
});
