import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGit } from "../server/git.js";
import { createSeed, releaseSeed, seedBundle } from "../server/seed.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, encoding: "utf8" }).trim();

/** A bare "origin" with main and feat, and a clone of it standing in for the daemon's project checkout. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kube-seed-"));
  const origin = join(root, "origin.git");
  const project = join(root, "project");
  mkdirSync(origin);
  sh(origin, "init", "-q", "--bare", "-b", "main");
  sh(root, "clone", "-q", origin, project);
  writeFileSync(join(project, "a.txt"), "one\n");
  sh(project, "add", ".");
  sh(project, "commit", "-qm", "one");
  sh(project, "push", "-q", "origin", "main");
  sh(project, "checkout", "-q", "-b", "feat");
  writeFileSync(join(project, "b.txt"), "two\n");
  sh(project, "add", ".");
  sh(project, "commit", "-qm", "two");
  sh(project, "push", "-q", "origin", "feat");
  sh(project, "checkout", "-q", "main");
  return { root, origin, project };
}

const bundleFiles = async (project: string, seed: Awaited<ReturnType<typeof createSeed>>) => {
  const { stream, done } = seedBundle(project, seed);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  await done;
  const out = join(mkdtempSync(join(tmpdir(), "kube-seed-out-")), "s.bundle");
  writeFileSync(out, Buffer.concat(chunks));
  const clone = join(mkdtempSync(join(tmpdir(), "kube-seed-pod-")), "w");
  sh(tmpdir(), "init", "-q", clone);
  sh(clone, "fetch", "-q", out, `${seed.ref}:refs/heads/${seed.branch}`);
  sh(clone, "checkout", "-q", seed.branch);
  return clone;
};

describe("seed from the daemon's checkout", () => {
  it("without a plan seeds the checkout's current HEAD, including unpushed commits", async () => {
    const { project } = fixture();
    writeFileSync(join(project, "local.txt"), "x\n");
    sh(project, "add", ".");
    sh(project, "commit", "-qm", "local only");
    const seed = await createSeed(runGit, project, null, "main");
    expect(seed.branch).toBe("main");
    const pod = await bundleFiles(project, seed);
    expect(sh(pod, "log", "-1", "--format=%s")).toBe("local only");
    await releaseSeed(runGit, project, seed);
    expect(execFileSync("git", ["for-each-ref", "refs/kube-seed"], { cwd: project, encoding: "utf8" })).toBe("");
  });

  it("seeds the picked branch from origin, fetching it when the daemon does not have it yet", async () => {
    const { project, root, origin } = fixture();
    // someone else pushes a new branch the project checkout has never seen
    const other = join(root, "other");
    sh(root, "clone", "-q", origin, other);
    sh(other, "checkout", "-q", "-b", "newer");
    writeFileSync(join(other, "n.txt"), "n\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "from elsewhere");
    sh(other, "push", "-q", "origin", "newer");

    const seed = await createSeed(runGit, project, { action: "branch-off", branch: "newer", slug: "s" }, "main");
    expect(seed.branch).toBe("newer");
    const pod = await bundleFiles(project, seed);
    expect(sh(pod, "log", "-1", "--format=%s")).toBe("from elsewhere");
  });

  it("fetches the checked-out branch fresh: a stale checkout is seeded from the remote's tip, unpushed work is kept", async () => {
    const { project, root, origin } = fixture();
    const other = join(root, "other2");
    sh(root, "clone", "-q", origin, other);
    writeFileSync(join(other, "up.txt"), "u\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "upstream moved on");
    sh(other, "push", "-q", "origin", "main");

    const stale = await createSeed(runGit, project, null, "main");
    expect(sh(project, "log", "-1", "--format=%s", stale.ref)).toBe("upstream moved on");
    await releaseSeed(runGit, project, stale);

    writeFileSync(join(project, "mine.txt"), "m\n");
    sh(project, "add", ".");
    sh(project, "commit", "-qm", "unpushed");
    const diverged = await createSeed(runGit, project, { action: "checkout", branch: "main" }, "main");
    expect(sh(project, "log", "-1", "--format=%s", diverged.ref)).toBe("unpushed");
  });

  it("branches off the remote's current base, not the daemon's stale copy", async () => {
    const { project, root, origin } = fixture();
    const other = join(root, "other3");
    sh(root, "clone", "-q", origin, other);
    writeFileSync(join(other, "up.txt"), "u\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "base moved");
    sh(other, "push", "-q", "origin", "main");
    const seed = await createSeed(runGit, project, { action: "branch-off", branch: "main", slug: "s" }, "main");
    expect(sh(project, "log", "-1", "--format=%s", seed.ref)).toBe("base moved");
  });

  it("seeds a pull request's head", async () => {
    const { project, origin } = fixture();
    sh(origin, "update-ref", "refs/pull/7/head", sh(origin, "rev-parse", "refs/heads/feat"));
    const seed = await createSeed(runGit, project, { action: "checkout", pullRequest: 7 }, "main");
    expect(seed.branch).toBe("pr-7");
    const pod = await bundleFiles(project, seed);
    expect(sh(pod, "log", "-1", "--format=%s")).toBe("two");
  });

  it("fails clearly for a branch that exists nowhere", async () => {
    const { project } = fixture();
    await expect(createSeed(runGit, project, { action: "checkout", branch: "nope" }, "main")).rejects.toThrow(/nope was not found/);
  });
});
