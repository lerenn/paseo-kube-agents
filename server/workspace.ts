import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const CLONE_SCRIPT =
  'git -c credential.helper="!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f" ' +
  'clone --branch "$1" -- "$2" "$3"';

/** Clones the branch into the pod. Only committed, pushed state is visible to the agent. */
export async function cloneIntoPod(kube: Kube, pod: string, repo: RepoRef, dir: string): Promise<void> {
  const result = await kube.exec(pod, ["sh", "-c", CLONE_SCRIPT, "sh", repo.branch, repo.url, dir]);
  if (result.code !== 0) {
    throw new Error(`git clone of ${repo.url}@${repo.branch} failed in pod: ${result.stderr.trim()}`);
  }
}
