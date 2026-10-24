import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPush, type BridgeReply, type PushRequest } from "./bridge.js";
import { type GitRunner, scrub } from "./git.js";
import { toHttpsRemote } from "./workspace.js";

/**
 * A remote the pod may fetch from: the project's origin and its submodules. The pod sees each one as a local
 * mirror repository (git rewrites the remote's URL to it); the daemon refreshes the mirror from `daemonUrl`
 * with its own credentials when the pod asks, so the pod never holds a GitHub credential.
 */
export interface FetchTarget {
  /** Directory name of the mirror in the pod (`$HOME/mirrors/<id>.git`). */
  id: string;
  /** URLs git in the pod may use for this remote. */
  podUrls: string[];
  /** URL the daemon fetches from. */
  daemonUrl: string;
  /** The project's origin: its mirror borrows objects from the pod's checkout. */
  origin: boolean;
}

const MAX_PACK_BYTES = 64 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;

export const mirrorId = (url: string): string => createHash("sha1").update(url).digest("hex").slice(0, 16);

const normalize = (url: string) => toHttpsRemote(url).replace(/\.git$/, "").replace(/\/$/, "");

/** Resolves a submodule URL (possibly relative, like `../other.git`) against the project's remote. */
export function resolveSubmoduleUrl(base: string, url: string): string {
  if (!url.startsWith("./") && !url.startsWith("../")) return url;
  const parts = base.replace(/\.git$/, "").replace(/\/$/, "").split("/");
  for (const seg of url.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** `.gitmodules` URLs recorded at the given commits of the daemon's checkout. */
async function submoduleUrls(git: GitRunner, cwd: string, shas: readonly string[]): Promise<string[]> {
  const urls = new Set<string>();
  for (const sha of shas) {
    if (!SHA.test(sha)) continue;
    const r = await git(["config", "--blob", `${sha}:.gitmodules`, "--get-regexp", "^submodule\\..*\\.url$"], { cwd });
    if (r.code !== 0) continue;
    for (const line of r.stdout.split("\n")) {
      const url = line.replace(/^\S+\s+/, "").trim();
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

/** Everything the pod may fetch from: the project's origin, plus the submodules recorded at `shas`. */
export async function fetchTargets(
  git: GitRunner,
  cwd: string,
  originUrl: string,
  shas: readonly string[],
): Promise<FetchTarget[]> {
  const originHttps = toHttpsRemote(originUrl);
  const targets: FetchTarget[] = [
    { id: mirrorId(normalize(originUrl)), podUrls: [...new Set([originHttps, originUrl])], daemonUrl: originUrl, origin: true },
  ];
  for (const raw of await submoduleUrls(git, cwd, shas)) {
    // the daemon fetches the way the project is configured (ssh stays ssh, so the right key is used); the pod
    // may name the submodule either way
    const resolved = resolveSubmoduleUrl(originUrl, raw);
    const id = mirrorId(normalize(resolved));
    if (targets.some((t) => t.id === id)) continue;
    const viaHttps = resolveSubmoduleUrl(originHttps, raw);
    targets.push({ id, podUrls: [...new Set([resolved, toHttpsRemote(resolved), viaHttps])], daemonUrl: resolved, origin: false });
  }
  return targets;
}

/**
 * Shell run in the pod to (re)create the mirrors and point git at them. Idempotent. `HOME` is the volume, so the
 * global config survives pod restarts and applies to submodules too.
 */
export const MIRROR_SETUP_SCRIPT = `set -e
mkdir -p "$HOME/mirrors"
git config --global protocol.file.allow always
git config --global push.autoSetupRemote true
git config --global remote.origin.uploadpack "$HOME/bin/paseo-upload-pack"
cwd="$1"; name="$2"; email="$3"; shift 3
git config --global user.name "$name"
git config --global user.email "$email"
while [ $# -gt 0 ]; do
  id="$1"; origin="$2"; shift 2
  urls=""
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do urls="$urls $1"; shift; done
  [ "$1" = "--" ] && shift
  d="$HOME/mirrors/$id.git"
  [ -d "$d" ] || git init -q --bare "$d"
  mkdir -p "$d/hooks" "$d/objects/info"
  cp "$HOME/mirror-pre-receive" "$d/hooks/pre-receive"
  if [ "$origin" = "1" ]; then echo "$cwd/.git/objects" > "$d/objects/info/alternates"; fi
  # file:// (not a bare path) so clones go through upload-pack instead of copying the still-empty mirror
  git config --global --unset-all "url.file://$d.insteadOf" || true
  for u in $urls; do git config --global --add "url.file://$d.insteadOf" "$u"; done
done
`;

/** Arguments of `MIRROR_SETUP_SCRIPT` after `sh -c <script> sh`. */
export function mirrorSetupArgs(cwd: string, identity: { name: string; email: string }, targets: readonly FetchTarget[]): string[] {
  return [cwd, identity.name, identity.email, ...targets.flatMap((t) => [t.id, t.origin ? "1" : "0", ...t.podUrls, "--"])];
}

export type FetchRequest = { op: "fetch"; mirror: string; haves: string[] };

export interface FetchReply {
  ok: boolean;
  message?: string;
  refs?: [string, string][];
  /** The remote's default branch (`refs/heads/...`), so `origin/HEAD` resolves in the pod. */
  head?: string;
  pack?: string;
}

/** The daemon-side cache a target is fetched into (a bare repository next to the project's git dir). */
export async function cacheDir(git: GitRunner, cwd: string, target: FetchTarget): Promise<string> {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (common.code !== 0) throw new Error(`not a git checkout: ${scrub(common.stderr.trim())}`);
  const dir = join(common.stdout.trim(), "kube-mirrors", `${target.id}.git`);
  const exists = await git(["rev-parse", "--git-dir"], { cwd: dir }).then((r) => r.code === 0, () => false);
  if (!exists) {
    await mkdir(dir, { recursive: true });
    const init = await git(["init", "-q", "--bare", dir]);
    if (init.code !== 0) throw new Error(`could not create the fetch cache: ${scrub(init.stderr.trim())}`);
  }
  if (target.origin) {
    // borrow the checkout's objects so the first fetch only transfers what the checkout lacks
    await mkdir(join(dir, "objects", "info"), { recursive: true });
    await writeFile(join(dir, "objects", "info", "alternates"), `${join(common.stdout.trim(), "objects")}\n`);
  }
  return dir;
}

/**
 * Refreshes the target in the daemon's cache from the real remote (daemon credentials), then answers the pod
 * with every branch and tag plus a thin pack of what the pod does not have yet.
 */
export async function applyFetch(
  git: GitRunner,
  cwd: string,
  request: FetchRequest,
  targets: readonly FetchTarget[],
): Promise<FetchReply> {
  const target = targets.find((t) => t.id === request.mirror);
  if (!target) return { ok: false, message: "kube-agents: this remote is not part of the project (only its origin and submodules can be fetched from a pod)" };
  if (!Array.isArray(request.haves) || !request.haves.every((h) => SHA.test(h))) return { ok: false, message: "kube-agents: malformed fetch request" };
  const dir = await cacheDir(git, cwd, target);

  const fetched = await git(
    ["fetch", "--prune", "--force", "--no-tags", target.daemonUrl, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"],
    { cwd: dir },
  );
  if (fetched.code !== 0) {
    return { ok: false, message: `kube-agents: fetch from ${scrub(target.daemonUrl)} failed on the daemon:\n${scrub(fetched.stderr.trim())}` };
  }
  const symref = await git(["ls-remote", "--symref", target.daemonUrl, "HEAD"], { cwd: dir });
  const head = /^ref: (refs\/heads\/\S+)\s+HEAD/m.exec(symref.stdout)?.[1];
  const listed = await git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"], { cwd: dir });
  if (listed.code !== 0) return { ok: false, message: `kube-agents: ${scrub(listed.stderr.trim())}` };
  const refs: [string, string][] = listed.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ") as [string, string])
    .map(([sha, ref]) => [ref!, sha!]);

  // only the haves that exist here can be used as pack bases
  const known = request.haves.length
    ? (await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: dir, input: Buffer.from(request.haves.join("\n") + "\n") })).stdout
        .split("\n")
        .filter((l) => l && !l.includes("missing"))
        .map((l) => l.split(" ")[0]!)
    : [];
  const wanted = [...new Set(refs.map(([, sha]) => sha))].filter((sha) => !known.includes(sha));
  let pack = "";
  if (wanted.length) {
    const input = Buffer.from([...wanted, ...known.map((h) => `^${h}`)].join("\n") + "\n");
    const made = await git(["pack-objects", "--revs", "--thin", "--stdout", "-q"], { cwd: dir, input, binary: true });
    if (made.code !== 0) return { ok: false, message: `kube-agents: could not pack the fetched commits: ${scrub(made.stderr.trim())}` };
    pack = made.stdoutBuffer!.toString("base64");
    if (pack.length > MAX_PACK_BYTES * 1.4) return { ok: false, message: "kube-agents: the fetch is too large to relay through the cluster API (over 64MB)" };
  }
  return { ok: true, refs, ...(head ? { head } : {}), ...(pack ? { pack } : {}) };
}

/** A pod's push to a submodule's mirror: applied in the daemon's cache of that remote and pushed from there. */
export async function pushToMirror(
  git: GitRunner,
  cwd: string,
  request: PushRequest,
  targets: readonly FetchTarget[],
): Promise<BridgeReply> {
  const target = targets.find((t) => t.id === request.mirror);
  if (!target) return { ok: false, message: "kube-agents: this remote is not part of the project (only its origin and submodules can be pushed to from a pod)" };
  const dir = await cacheDir(git, cwd, target);
  return applyPush(git, cwd, request, { dir, remote: target.daemonUrl });
}
