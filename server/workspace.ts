import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REF_ENV_KEYS } from "../shared/pod-ref.js";
import { WORKSPACE_ROOT } from "./sandbox.js";
import type { Kube } from "./kube.js";

const execFileAsync = promisify(execFile);

export interface RepoRef {
  url: string;
  branch: string;
}

/** SSH remotes become https so the pod can clone with GH_TOKEN instead of a key. */
export function toHttpsRemote(url: string): string {
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return url;
}

export async function detectRepo(cwd: string): Promise<RepoRef> {
  const git = async (...args: string[]) =>
    (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
  const url = toHttpsRemote(await git("remote", "get-url", "origin"));
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "HEAD") throw new Error(`${cwd} has a detached HEAD; check out a branch first`);
  return { url, branch };
}

export function podWorkdir(sessionName: string): string {
  return `${WORKSPACE_ROOT}/${sessionName}`;
}

const HELPER = 'credential.helper=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f';
const CLONE_SCRIPT = `git -c "${HELPER}" clone --branch "$1" -- "$2" "$3"`;
const CLONE_DEFAULT_SCRIPT = `git -c "${HELPER}" clone -- "$1" "$2"`;
const CHECKOUT_NEW_BRANCH = 'git -C "$1" checkout -b "$2"';
const FETCH_PR_SCRIPT = `git -c "${HELPER}" -C "$1" fetch origin "pull/$2/head:pr-$2" && git -C "$1" checkout "pr-$2"`;

/** What Paseo's branch picker chose, handed to the provider through the agent's env. */
export interface ClonePlan {
  action: "branch-off" | "checkout";
  /** Base branch (branch-off) or branch to open (checkout), without the refs/heads/ prefix. */
  branch?: string;
  /** Pull request number, when a change request was picked. */
  pullRequest?: number;
  /** Name of the new branch for branch-off, and of the pod. */
  slug?: string;
}

const REF_ENV = REF_ENV_KEYS;

export function shortBranch(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes\/origin)\//, "").replace(/^origin\//, "");
}

export function parseClonePlan(env: Readonly<Record<string, string>>): ClonePlan | null {
  const action = env[REF_ENV.action];
  if (action !== "branch-off" && action !== "checkout") return null;
  const pr = Number.parseInt(env[REF_ENV.pullRequest] ?? "", 10);
  return {
    action,
    ...(env[REF_ENV.ref] ? { branch: shortBranch(env[REF_ENV.ref]!) } : {}),
    ...(Number.isFinite(pr) ? { pullRequest: pr } : {}),
    ...(env[REF_ENV.slug] ? { slug: env[REF_ENV.slug] } : {}),
  };
}

/** Repository name from a remote URL, for naming. */
export function repoName(url: string): string {
  return url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "repo";
}

async function run(kube: Kube, pod: string, script: string, args: string[], what: string): Promise<void> {
  const result = await kube.exec(pod, ["sh", "-c", script, "sh", ...args]);
  if (result.code !== 0) throw new Error(`${what} failed in pod: ${result.stderr.trim()}`);
}

/**
 * Clones into the pod. Only committed, pushed state is visible to the agent. Without a plan this
 * clones the daemon checkout's current branch; with one it follows the branch picker.
 */
export async function cloneIntoPod(
  kube: Kube,
  pod: string,
  repo: RepoRef,
  dir: string,
  plan?: ClonePlan | null,
): Promise<void> {
  if (!plan) {
    return run(kube, pod, CLONE_SCRIPT, [repo.branch, repo.url, dir], `git clone of ${repo.url}@${repo.branch}`);
  }
  if (plan.pullRequest !== undefined) {
    await run(kube, pod, CLONE_DEFAULT_SCRIPT, [repo.url, dir], `git clone of ${repo.url}`);
    return run(kube, pod, FETCH_PR_SCRIPT, [dir, String(plan.pullRequest)], `checkout of PR #${plan.pullRequest}`);
  }
  const base = plan.branch ?? repo.branch;
  await run(kube, pod, CLONE_SCRIPT, [base, repo.url, dir], `git clone of ${repo.url}@${base}`);
  if (plan.action === "branch-off" && plan.slug) {
    await run(kube, pod, CHECKOUT_NEW_BRANCH, [dir, plan.slug], `creating branch ${plan.slug}`);
  }
}
