/**
 * Small scripts written into each pod at session start (no image dependency beyond Node and git).
 * They are plain strings so they ship inside the plugin bundle.
 */

/**
 * `serve` runs for the whole session over `kubectl exec` stdio, one JSON object per line: it relays
 * requests from pod-side helpers (a unix socket, used by the git hook) to the plugin on the daemon,
 * and tunnels loopback TCP ports to the daemon. `call` is the helper side used by the git hook.
 */
export const BRIDGE_SCRIPT = String.raw`import net from "node:net";
import fs from "node:fs";
import readline from "node:readline";

const [mode, ...args] = process.argv.slice(2);
const sock = (process.env.HOME || ".") + "/bridge.sock";

if (mode === "call") {
  const op = args[0];
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const msg = { op };
  if (op === "push") {
    msg.ref = args[1]; msg.old = args[2]; msg.new = args[3]; msg.base = args[4];
    msg.pack = Buffer.concat(chunks).toString("base64");
  }
  const conn = net.connect(sock);
  let out = "";
  conn.on("error", (e) => { console.error("kube-agents: bridge unavailable: " + e.message); process.exit(1); });
  conn.on("data", (d) => (out += d));
  conn.on("end", () => {
    let r;
    try { r = JSON.parse(out); } catch { console.error("kube-agents: bad bridge reply"); process.exit(1); }
    if (r.message) console.error(r.message);
    process.exit(r.ok ? 0 : 1);
  });
  conn.end(JSON.stringify(msg) + "\n");
} else if (mode === "serve") {
  const pending = new Map();
  let next = 1;
  const ask = (msg) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    process.stdout.write(JSON.stringify({ id, ...msg }) + "\n");
  });
  let tunnelIn = () => {};
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    try {
      const r = JSON.parse(line);
      if (r.tcp) { tunnelIn(r); return; }
      pending.get(r.id)?.(r); pending.delete(r.id);
    } catch {}
  }).on("close", () => process.exit(0));

  try { fs.unlinkSync(sock); } catch {}
  net.createServer({ allowHalfOpen: true }, (c) => {
    let buf = "";
    c.on("data", (d) => { buf += d; if (buf.includes("\n")) { const line = buf; buf = ""; handle(c, line); } });
    c.on("error", () => {});
  }).listen(sock);
  const handle = async (c, line) => {
    let reply;
    try { reply = await ask(JSON.parse(line)); } catch (e) { reply = { ok: false, message: "kube-agents: " + e.message }; }
    c.end(JSON.stringify(reply));
  };

  // Loopback TCP tunnels: listen on the same ports inside the pod and carry each connection to the
  // daemon's loopback port over this channel, so URLs and headers in the agent's config stay as they are.
  const conns = new Map();
  let cid = 0;
  const frame = (f) => process.stdout.write(JSON.stringify(f) + "\n");
  for (const port of (args[0] || "").split(",").map(Number).filter(Boolean)) {
    net.createServer((c) => {
      const id = ++cid;
      conns.set(id, c);
      frame({ tcp: "open", cid: id, port });
      c.on("data", (d) => frame({ tcp: "data", cid: id, b64: d.toString("base64") }));
      c.on("close", () => { if (conns.delete(id)) frame({ tcp: "end", cid: id }); });
      c.on("error", () => {});
    }).on("error", (e) => process.stderr.write("kube-agents bridge: port " + port + ": " + e.message + "\n")).listen(port, "127.0.0.1");
  }
  tunnelIn = (r) => {
    const c = conns.get(r.cid);
    if (!c) return;
    if (r.tcp === "data") c.write(Buffer.from(r.b64, "base64"));
    else if (r.tcp === "end") { conns.delete(r.cid); c.end(); }
  };
}
`;

/** `gh` in the pod: same contract as the GitHub Proxy plugin's shim, pointed at its loopback URL. */
export const GH_SHIM_SCRIPT = String.raw`#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const url = process.env.PASEO_GITHUB_PROXY_URL;
const capability = process.env.PASEO_GITHUB_PROXY_CAPABILITY;
if (!url || !capability) {
  process.stderr.write("gh: no GitHub access is configured for this pod (enable the GitHub Proxy plugin for this agent).\n");
  process.exit(1);
}
(async () => {
  let res;
  try {
    res = await fetch(url + "/gh", {
      method: "POST",
      headers: { authorization: "Bearer " + capability, "content-type": "application/json" },
      body: JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }),
    });
  } catch (err) {
    process.stderr.write("gh: cannot reach the GitHub proxy: " + err.message + "\n");
    process.exit(1);
  }
  if (!res.ok) {
    process.stderr.write("gh: proxy answered HTTP " + res.status + ": " + (await res.text()) + "\n");
    process.exit(1);
  }
  const out = await res.json();
  let stdout = out.stdout;
  if (out.jq && out.code === 0) {
    const r = spawnSync("jq", ["-r", out.jq], { input: stdout, encoding: "utf8" });
    if (!r.error) stdout = r.stdout;
  }
  if (stdout) process.stdout.write(stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.code ?? 0);
})();
`;

/**
 * pre-receive hook of the pod's local "outbox" repository, which is the checkout's push URL. A
 * `git push` there asks the plugin to push the new commits for real, with the daemon's credentials;
 * the answer decides whether the push is accepted, so the agent sees ordinary git results.
 */
export const PRE_RECEIVE_HOOK = String.raw`#!/bin/sh
ZERO=0000000000000000000000000000000000000000
while read old new ref; do
  if [ "$new" = "$ZERO" ]; then
    echo "kube-agents: deleting remote branches from a pod is not supported" >&2
    exit 1
  fi
  base="$old"
  [ "$old" = "$ZERO" ] && base=$(cat "$HOME/seed.sha")
  { echo "$new"; echo "^$base"; } | git pack-objects --revs --stdout --thin 2>/dev/null \
    | node "$HOME/bridge.mjs" call push "$ref" "$old" "$new" "$base" || exit 1
done
exit 0
`;

/**
 * Starts a provider process: loads its env file (then deletes it), moves to the workspace directory, puts the
 * shims and installed CLIs on PATH, and runs the command exactly as the provider asked.
 * Arguments: env file, directory, then the command and its arguments.
 */
export const LAUNCH_SCRIPT = `. "$1" || exit 1; rm -f "$1"; cd "$2" || exit 1; shift 2; export PATH="$HOME/bin:$HOME/.npm-global/bin:$PATH"; exec "$@"`;

/** An env file for the provider process: the env delta Paseo asked for, and nothing from the daemon. */
export function envFile(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'\n`)
    .join("");
}

/** Provider commands the runtime can install on first use when the image lacks them. */
export const INSTALLABLE_CLIS: Readonly<Record<string, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};
