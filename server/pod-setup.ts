import { Readable } from "node:stream";
import { HOME_DIR } from "./sandbox.js";
import { BRIDGE_SCRIPT, GH_SHIM_SCRIPT, INSTALLABLE_CLIS, PRE_RECEIVE_HOOK, envFile } from "./pod-assets.js";
import type { Kube } from "./kube.js";
import type { Seed } from "./seed.js";

const write = async (kube: Kube, pod: string, rel: string, content: string, mode: string) => {
  const r = await kube.execInput(
    pod,
    ["sh", "-c", 'p="$HOME/$1"; mkdir -p "$(dirname "$p")" && cat > "$p" && chmod "$2" "$p"', "sh", rel, mode],
    Readable.from([Buffer.from(content)]),
  );
  if (r.code !== 0) throw new Error(`could not write ${rel} in the pod: ${r.stderr.trim()}`);
};

/** Writes the bridge, the `gh` shim and the push hook into the pod. Safe to repeat. */
export async function installAssets(kube: Kube, pod: string): Promise<void> {
  await write(kube, pod, "bridge.mjs", BRIDGE_SCRIPT, "644");
  await write(kube, pod, "bin/gh", GH_SHIM_SCRIPT, "755");
  await write(kube, pod, "outbox.git/hooks/pre-receive", PRE_RECEIVE_HOOK, "755");
}

const SEED_SCRIPT = `set -e
dir="$1"
git init -q "$dir"
git -C "$dir" fetch -q "$HOME/seed.bundle" "$2:refs/heads/$3"
git -C "$dir" checkout -q "$3"
git -C "$dir" remote add origin "$4"
git init -q --bare "$HOME/outbox.git"
git -C "$dir" config remote.origin.pushurl "$HOME/outbox.git"
git -C "$dir" config user.name "$5"
git -C "$dir" config user.email "$6"
echo "$7" > "$HOME/seed.sha"
if [ -n "$8" ]; then git -C "$dir" checkout -q -b "$8"; fi
rm -f "$HOME/seed.bundle"
`;

export interface SeedTarget {
  dir: string;
  originUrl: string;
  identity: { name: string; email: string };
  /** New branch to create from the seed (branch-off). */
  newBranch?: string;
}

/** Copies the bundle in over the Kubernetes API and builds the workspace from it: no GitHub access. */
export async function seedWorkspace(
  kube: Kube,
  pod: string,
  seed: Seed,
  bundle: Readable,
  target: SeedTarget,
): Promise<void> {
  const copied = await kube.execInput(pod, ["sh", "-c", 'mkdir -p "$HOME" && cat > "$HOME/seed.bundle"'], bundle);
  if (copied.code !== 0) throw new Error(`could not copy the seed bundle into the pod: ${copied.stderr.trim()}`);
  const built = await kube.exec(pod, [
    "sh",
    "-c",
    SEED_SCRIPT,
    "sh",
    target.dir,
    seed.ref,
    seed.branch,
    target.originUrl,
    target.identity.name,
    target.identity.email,
    seed.sha,
    target.newBranch ?? "",
  ]);
  if (built.code !== 0) throw new Error(`could not build the workspace in the pod: ${built.stderr.trim()}`);
}

/** Writes the env file of one provider process and returns its path inside the pod. */
export async function writeEnvFile(kube: Kube, pod: string, id: string, env: Readonly<Record<string, string>>): Promise<string> {
  const rel = `.exec-env/${id}`;
  await write(kube, pod, rel, envFile(env), "600");
  return `${HOME_DIR}/${rel}`;
}

/** Makes sure the provider's command exists in the pod, installing claude or codex once (on the volume) if not. */
export async function ensureCommand(kube: Kube, pod: string, command: string): Promise<void> {
  const present = await kube.exec(pod, ["sh", "-c", 'export PATH="$HOME/bin:$HOME/.npm-global/bin:$PATH"; command -v "$1" >/dev/null 2>&1', "sh", command]);
  if (present.code === 0) return;
  const pkg = INSTALLABLE_CLIS[command];
  if (!pkg) throw new Error(`${command} is not in the pod image and cannot be installed automatically; use an image that contains it`);
  const installed = await kube.exec(pod, ["sh", "-c", 'npm install -g --prefix "$HOME/.npm-global" "$1" >/dev/null 2>&1', "sh", pkg]);
  if (installed.code !== 0) throw new Error(`could not install ${pkg} in the pod: ${installed.stderr.trim() || "npm failed"}`);
}
