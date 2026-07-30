import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fetchRemote, getHeadCommit, getUpstreamCommit, pull } from "./git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

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

describe("pull", () => {
  let remoteDir: string | undefined;
  let localDir: string | undefined;
  let otherCloneDir: string | undefined;

  afterEach(async () => {
    for (const dir of [remoteDir, localDir, otherCloneDir]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    remoteDir = undefined;
    localDir = undefined;
    otherCloneDir = undefined;
  });

  // Real git clone/push/pull round-trips (and git's own auth-prompt timeout
  // in the diverged case) are slower than vitest's 5s default.
  it("fast-forwards to new commits pushed by someone else", async () => {
    remoteDir = await mkdtemp(path.join(tmpdir(), "hub-git-remote-"));
    await git(remoteDir, "init", "-q", "--bare");

    localDir = await mkdtemp(path.join(tmpdir(), "hub-git-local-"));
    await git(path.dirname(localDir), "clone", "-q", remoteDir, localDir);
    await git(localDir, "config", "user.email", "test@example.com");
    await git(localDir, "config", "user.name", "Test");
    await writeFile(path.join(localDir, "file.txt"), "v1");
    await git(localDir, "add", ".");
    await git(localDir, "commit", "-q", "-m", "initial");
    await git(localDir, "push", "-q", "origin", "HEAD");

    otherCloneDir = await mkdtemp(path.join(tmpdir(), "hub-git-other-"));
    await git(path.dirname(otherCloneDir), "clone", "-q", remoteDir, otherCloneDir);
    await git(otherCloneDir, "config", "user.email", "test@example.com");
    await git(otherCloneDir, "config", "user.name", "Test");
    await writeFile(path.join(otherCloneDir, "file.txt"), "v2");
    await git(otherCloneDir, "commit", "-q", "-am", "update");
    await git(otherCloneDir, "push", "-q", "origin", "HEAD");
    const expectedHead = (await getHeadCommit(otherCloneDir))!.trim();

    const result = await pull(localDir);

    expect(result.success).toBe(true);
    expect(await getHeadCommit(localDir)).toBe(expectedHead);
  }, 15_000);

  it("fails cleanly instead of merging when the local branch has diverged", async () => {
    remoteDir = await mkdtemp(path.join(tmpdir(), "hub-git-remote-"));
    await git(remoteDir, "init", "-q", "--bare");

    localDir = await mkdtemp(path.join(tmpdir(), "hub-git-local-"));
    await git(path.dirname(localDir), "clone", "-q", remoteDir, localDir);
    await git(localDir, "config", "user.email", "test@example.com");
    await git(localDir, "config", "user.name", "Test");
    await writeFile(path.join(localDir, "file.txt"), "v1");
    await git(localDir, "add", ".");
    await git(localDir, "commit", "-q", "-m", "initial");
    await git(localDir, "push", "-q", "origin", "HEAD");

    otherCloneDir = await mkdtemp(path.join(tmpdir(), "hub-git-other-"));
    await git(path.dirname(otherCloneDir), "clone", "-q", remoteDir, otherCloneDir);
    await git(otherCloneDir, "config", "user.email", "test@example.com");
    await git(otherCloneDir, "config", "user.name", "Test");
    await writeFile(path.join(otherCloneDir, "file.txt"), "v2");
    await git(otherCloneDir, "commit", "-q", "-am", "remote update");
    await git(otherCloneDir, "push", "-q", "origin", "HEAD");

    // Diverge locally instead of pulling first.
    await writeFile(path.join(localDir, "file.txt"), "v1-local-edit");
    await git(localDir, "commit", "-q", "-am", "local divergent commit");
    const localHeadBeforePull = (await getHeadCommit(localDir))!.trim();

    const result = await pull(localDir);

    expect(result.success).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    expect(await getHeadCommit(localDir)).toBe(localHeadBeforePull);
  }, 15_000);
});

describe("fetchRemote / getUpstreamCommit", () => {
  let remoteDir: string | undefined;
  let localDir: string | undefined;
  let otherCloneDir: string | undefined;

  afterEach(async () => {
    for (const dir of [remoteDir, localDir, otherCloneDir]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    remoteDir = undefined;
    localDir = undefined;
    otherCloneDir = undefined;
  });

  it("sees a commit pushed by someone else without pulling it into the working tree", async () => {
    remoteDir = await mkdtemp(path.join(tmpdir(), "hub-git-remote-"));
    await git(remoteDir, "init", "-q", "--bare");

    localDir = await mkdtemp(path.join(tmpdir(), "hub-git-local-"));
    await git(path.dirname(localDir), "clone", "-q", remoteDir, localDir);
    await git(localDir, "config", "user.email", "test@example.com");
    await git(localDir, "config", "user.name", "Test");
    await writeFile(path.join(localDir, "file.txt"), "v1");
    await git(localDir, "add", ".");
    await git(localDir, "commit", "-q", "-m", "initial");
    await git(localDir, "push", "-q", "origin", "HEAD");
    const localHeadBeforeFetch = (await getHeadCommit(localDir))!.trim();

    otherCloneDir = await mkdtemp(path.join(tmpdir(), "hub-git-other-"));
    await git(path.dirname(otherCloneDir), "clone", "-q", remoteDir, otherCloneDir);
    await git(otherCloneDir, "config", "user.email", "test@example.com");
    await git(otherCloneDir, "config", "user.name", "Test");
    await writeFile(path.join(otherCloneDir, "file.txt"), "v2");
    await git(otherCloneDir, "commit", "-q", "-am", "update");
    await git(otherCloneDir, "push", "-q", "origin", "HEAD");
    const expectedRemoteHead = (await getHeadCommit(otherCloneDir))!.trim();

    const fetchResult = await fetchRemote(localDir);
    expect(fetchResult.success).toBe(true);

    expect(await getUpstreamCommit(localDir)).toBe(expectedRemoteHead);
    // fetch must not touch the working tree/HEAD — only `pull` should do that.
    expect(await getHeadCommit(localDir)).toBe(localHeadBeforeFetch);
  }, 15_000);

  it("returns null upstream for a repo with no tracking branch configured", async () => {
    localDir = await mkdtemp(path.join(tmpdir(), "hub-git-local-"));
    await execFileAsync("git", ["init", "-q"], { cwd: localDir });
    expect(await getUpstreamCommit(localDir)).toBeNull();
  });
});
