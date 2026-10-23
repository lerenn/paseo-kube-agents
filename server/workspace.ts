import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REF_ENV_KEYS } from "../shared/pod-ref.js";
import { WORKSPACE_ROOT } from "./sandbox.js";

const execFileAsync = promisify(execFile);

export interface RepoRef {
  url: string;
  branch: string;
}

/** SSH remotes become https so the remote is a plain URL without an ssh key requirement. */
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
