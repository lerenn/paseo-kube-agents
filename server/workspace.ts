import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeOptions } from "../shared/runtime-options.js";

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

/** What Paseo's branch picker chose, as the seed needs it. */
export interface ClonePlan {
  action: "branch-off" | "checkout";
  /** Base branch (branch-off) or branch to open (checkout), without the refs/heads/ prefix. */
  branch?: string;
  /** Pull request number, when a change request was picked. */
  pullRequest?: number;
  /** Name of the new branch for branch-off. */
  slug?: string;
}

export function shortBranch(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes\/origin)\//, "").replace(/^origin\//, "");
}

/** The seed plan for a workspace's options; null seeds the checkout's current HEAD. */
export function clonePlan(options: RuntimeOptions): ClonePlan | null {
  const { ref, slug } = options;
  if (!ref) return null;
  return {
    action: ref.action,
    ...(ref.refName ? { branch: shortBranch(ref.refName) } : {}),
    ...(ref.changeRequest ? { pullRequest: ref.changeRequest.number } : {}),
    ...(slug ? { slug } : {}),
  };
}

/** Repository name from a remote URL, for naming. */
export function repoName(url: string): string {
  return url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "repo";
}
