import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { type GitRunner, scrub, streamGit } from "./git.js";
import type { ClonePlan } from "./workspace.js";

/** A commit from the daemon's checkout, pinned under a temporary ref so it can be bundled. */
export interface Seed {
  id: string;
  /** Temporary ref in the daemon's checkout, also the ref name inside the bundle. */
  ref: string;
  sha: string;
  /** Branch the pod checks out. */
  branch: string;
}

const need = async (git: GitRunner, cwd: string, args: string[], what: string): Promise<string> => {
  const r = await git(args, { cwd });
  if (r.code !== 0) throw new Error(`${what}: ${scrub(r.stderr.trim() || r.stdout.trim())}`);
  return r.stdout.trim();
};

const resolveRef = async (git: GitRunner, cwd: string, candidates: string[]): Promise<string | null> => {
  for (const ref of candidates) {
    const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
};

/**
 * Picks the commit the pod starts from, in the daemon's checkout: the picked branch (fetching it
 * first when the daemon's copy may be stale), a pull request's head, or the checkout's own HEAD.
 */
export async function createSeed(
  git: GitRunner,
  cwd: string,
  plan: ClonePlan | null,
  currentBranch: string,
): Promise<Seed> {
  const id = randomBytes(4).toString("hex");
  const ref = `refs/kube-seed/${id}`;
  let sha: string | null;
  let branch: string;
  if (plan?.pullRequest !== undefined) {
    await need(git, cwd, ["fetch", "origin", `pull/${plan.pullRequest}/head:${ref}`], `fetching PR #${plan.pullRequest}`);
    sha = await resolveRef(git, cwd, [ref]);
    branch = `pr-${plan.pullRequest}`;
  } else if (plan?.branch) {
    branch = plan.branch;
    await git(["fetch", "origin", branch], { cwd }); // best effort: the daemon's copy may be fresh already
    sha = await resolveRef(git, cwd, [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]);
  } else {
    branch = currentBranch;
    sha = await resolveRef(git, cwd, ["HEAD"]);
  }
  if (!sha) throw new Error(`Branch ${branch} was not found in ${cwd} or on origin`);
  await need(git, cwd, ["update-ref", ref, sha], "pinning the seed commit");
  return { id, ref, sha, branch };
}

/** The seed's history as a git bundle stream; call `release` when the transfer is over. */
export function seedBundle(cwd: string, seed: Seed): { stream: Readable; done: Promise<void> } {
  const { stdout, exit } = streamGit(["bundle", "create", "-", seed.ref], cwd);
  const done = exit.then(({ code, stderr }) => {
    if (code !== 0) throw new Error(`git bundle failed: ${scrub(stderr.trim())}`);
  });
  done.catch(() => undefined);
  return { stream: stdout, done };
}

export async function releaseSeed(git: GitRunner, cwd: string, seed: Seed): Promise<void> {
  await git(["update-ref", "-d", seed.ref], { cwd });
}
