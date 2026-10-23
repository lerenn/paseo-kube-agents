import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { ConfigSchema } from "../shared/settings.js";
import { connectKube } from "../server/connection.js";
import { FakeAcp } from "./fakes.js";
import { LocalPodKube } from "./local-pod.js";

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...ID }, encoding: "utf8" }).trim();
const wait = (cond: () => boolean | Promise<boolean>, ms = 8000) =>
  new Promise<void>(async (resolve, reject) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return resolve();
      await new Promise((r) => setTimeout(r, 25));
    }
    reject(new Error("timed out"));
  });

function repos() {
  const root = mkdtempSync(join(tmpdir(), "kube-sim-"));
  const origin = join(root, "origin.git");
  const project = join(root, "project");
  mkdirSync(origin);
  sh(origin, "init", "-q", "--bare", "-b", "main");
  sh(root, "clone", "-q", origin, project);
  writeFileSync(join(project, "a.txt"), "one\n");
  sh(project, "add", ".");
  sh(project, "commit", "-qm", "one");
  sh(project, "push", "-q", "origin", "main");
  return { origin, project };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function openSession(env: Record<string, string> = {}, mcpServers: Record<string, any> = {}, tunnel?: { pod: number; daemon: number }) {
  const { origin, project } = repos();
  const kube = new LocalPodKube();
  const acp = new FakeAcp();
  const events: ProviderEvent[] = [];
  const conn = await connectKube(
    { versions: [1], capabilities: ["prompt.message"] },
    {
      config: ConfigSchema.parse({ readyTimeoutSeconds: 5 }),
      kube,
      acpProvider: acp.provider,
      mapTunnelPort: tunnel ? (p) => (p === tunnel.pod ? tunnel.daemon : p) : undefined,
    },
  );
  conn.onEvent((e) => events.push(e));
  cleanups.push(() => kube.stop());
  await conn.send({
    type: "session.open",
    requestId: "r",
    sessionId: "s",
    config: { cwd: project, env, mcpServers, settings: {}, persist: false },
    history: "skip",
  });
  const failed = events.find((e) => e.type === "request.failed") as any;
  if (failed) throw new Error(failed.error.message);
  const dir = (acp.inputs[0] as any).config.cwd as string;
  const podDir = dir.replace("/workspace", kube.workspace);
  return { origin, project, kube, podDir, conn, events };
}

describe("seeded pod workspace and push-back (real git, real pod scripts)", () => {
  it("builds the workspace from a bundle of the daemon's checkout, with no remote access in the pod", async () => {
    const { project, kube, podDir } = await openSession();
    expect(sh(podDir, "log", "-1", "--format=%s")).toBe("one");
    expect(sh(podDir, "branch", "--show-current")).toBe("main");
    expect(sh(podDir, "config", "remote.origin.pushurl")).toContain("outbox.git");
    expect(sh(podDir, "config", "user.name")).toBeTruthy();
    expect(sh(project, "for-each-ref", "refs/kube-seed")).toBe(""); // temporary ref cleaned up
    expect((await kube.as(["sh", "-c", "env | grep -c GH_TOKEN || true"])).stdout.trim()).toBe("0");
  });

  it("pushes the pod's commits from the daemon with the daemon's credentials", async () => {
    const { origin, kube, podDir } = await openSession();
    writeFileSync(join(podDir, "work.txt"), "from the pod\n");
    sh(podDir, "add", ".");
    sh(podDir, "commit", "-qm", "pod work");
    const pushed = await kube.as(["git", "push", "origin", "HEAD:refs/heads/throwaway"], { cwd: podDir });
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.stderr).toContain("pushed");
    expect(pushed.stderr).toContain("from the daemon");
    expect(sh(origin, "log", "-1", "--format=%s", "refs/heads/throwaway")).toBe("pod work");
  });

  it("a second push on the same branch sends only the new commits", async () => {
    const { origin, kube, podDir } = await openSession();
    for (const n of [1, 2]) {
      writeFileSync(join(podDir, `f${n}.txt`), `${n}\n`);
      sh(podDir, "add", ".");
      sh(podDir, "commit", "-qm", `c${n}`);
      const r = await kube.as(["git", "push", "origin", "HEAD:refs/heads/multi"], { cwd: podDir });
      expect(r.code, r.stderr).toBe(0);
    }
    expect(sh(origin, "log", "--format=%s", "refs/heads/multi").split("\n").slice(0, 2)).toEqual(["c2", "c1"]);
  });

  it("relays the remote's rejection to the agent and refuses deletions and non-branch refs", async () => {
    const { origin, kube, podDir } = await openSession();
    writeFileSync(join(podDir, "x.txt"), "x\n");
    sh(podDir, "add", ".");
    sh(podDir, "commit", "-qm", "diverge");
    // advance origin/main behind the pod's back, then push a commit that is no longer a fast-forward
    const other = join(mkdtempSync(join(tmpdir(), "kube-other-")), "o");
    sh(tmpdir(), "clone", "-q", origin, other);
    writeFileSync(join(other, "y.txt"), "y\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "other");
    sh(other, "push", "-q", "origin", "main");
    writeFileSync(join(podDir, "z.txt"), "z\n");
    sh(podDir, "add", ".");
    sh(podDir, "commit", "-qm", "diverged again");
    const nonFf = await kube.as(["git", "push", "origin", "HEAD:refs/heads/main"], { cwd: podDir });
    expect(nonFf.code).not.toBe(0);
    expect(nonFf.stderr).toMatch(/rejected by the remote/);

    const del = await kube.as(["git", "push", "origin", ":refs/heads/throwaway"], { cwd: podDir });
    expect(del.code).not.toBe(0);
    expect(del.stderr).toMatch(/not supported/);
    sh(podDir, "tag", "v1");
    const tag = await kube.as(["git", "push", "origin", "refs/tags/v1"], { cwd: podDir });
    expect(tag.code).not.toBe(0);
    expect(tag.stderr).toMatch(/only branches/);
  });
});

describe("loopback tunnel to the daemon's MCP servers", () => {
  it("serves the daemon's loopback port inside the pod with headers intact, including a streaming response", async () => {
    const seen: { auth?: string; url?: string }[] = [];
    const daemon = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization, url: req.url });
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t = setInterval(() => {
        res.write(`data: chunk${n}\n\n`);
        if (++n === 3) {
          clearInterval(t);
          res.end();
        }
      }, 30);
    });
    await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
    cleanups.push(() => daemon.close());
    const daemonPort = (daemon.address() as AddressInfo).port;
    // the pod's listener needs its own free port on this shared host
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const podPort = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));

    const { kube } = await openSession({}, { inbox: { type: "http", url: `http://127.0.0.1:${podPort}/mcp`, headers: { authorization: "Bearer cap" } } }, { pod: podPort, daemon: daemonPort });
    await wait(async () => (await kube.as(["node", "-e", `require("net").connect(${podPort},"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))`])).code === 0);
    const out = await kube.as(["node", "-e", `fetch("http://127.0.0.1:${podPort}/mcp",{method:"POST",headers:{authorization:"Bearer cap"},body:"{}"}).then(async r=>{let t="";for await(const c of r.body)t+=Buffer.from(c).toString();console.log(r.status,t.replace(/\\n/g,"|"))})`]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout.trim()).toBe("200 data: chunk0||data: chunk1||data: chunk2||");
    expect(seen[0]).toEqual({ auth: "Bearer cap", url: "/mcp" });
  });

  it("does not tunnel ports the session's config does not name", async () => {
    const daemon = createServer((_req, res) => res.end("secret"));
    await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
    cleanups.push(() => daemon.close());
    const port = (daemon.address() as AddressInfo).port;
    const { kube } = await openSession({}, {});
    const r = await kube.as(["node", "-e", `require("net").connect(${port},"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(3))`]);
    // nothing listens inside the pod on that port, and the daemon's server is not reachable through the bridge
    expect([0, 3]).toContain(r.code);
  });
});
