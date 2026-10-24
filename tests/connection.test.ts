import { describe, expect, it } from "vitest";
import type { ProviderEvent, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { ConfigSchema } from "../server/config.js";
import { connectKube, isPreapproved } from "../server/connection.js";
import { FALLBACK_CATALOG } from "../server/catalog.js";
import { FakeAcp, FakeKube, fakeSeeder } from "./fakes.js";

const request = { versions: [1], capabilities: ["prompt.message", "permission"] };
const sessionConfig = (env: Record<string, string> = {}): ProviderSessionConfig => ({
  cwd: "/home/me/repo", env, mcpServers: {}, settings: {}, persist: false,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const repo = async () => ({ url: "https://github.com/lerenn/x", branch: "main" });

const fakeClock = () => {
  let t = 0;
  return () => (t += 1000);
};

function setup(overrides: Partial<ReturnType<typeof ConfigSchema.parse>> = {}) {
  const kube = new FakeKube();
  const acp = new FakeAcp();
  const config = ConfigSchema.parse({ image: "go:1", ...overrides });
  const events: ProviderEvent[] = [];
  const conn = connectKube(request, { config, kube, acpProvider: acp.provider, detectRepo: repo, seeder: fakeSeeder, catalog: async () => FALLBACK_CATALOG, sleep: async () => undefined, now: fakeClock() });
  return { kube, acp, events, conn };
}

describe("kube connection", () => {
  it("runs the full lifecycle: create, prompt, stream, close, delete", async () => {
    const { kube, acp, events, conn: p } = setup();
    const conn = await p;
    conn.onEvent((e) => events.push(e));

    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", config: sessionConfig(), history: "skip" });
    expect(kube.applied).toHaveLength(1);
    const name = (kube.applied[0] as any).metadata.name as string;
    // apply, wait for the pod, write the helper scripts (4 files), check the volume, seed from the bundle
    expect(kube.calls.slice(0, 8)).toEqual(["apply", `pod:${name}`, "execInput", "execInput", "execInput", "execInput", "exec", "execInput"]);
    expect(kube.inputs.map((i) => i.argv[4]).slice(0, 4)).toEqual(["bridge.mjs", "bin/gh", "outbox.git/hooks/pre-receive", ".kube-env"]);
    // the workspace is built from the daemon's bundle (no GitHub clone in the pod), and no token is involved
    expect(kube.inputs[4]!.argv.join(" ")).toContain("seed.bundle");
    const seedScript = kube.execs.find((e) => e.argv[2]?.includes("git init"))!;
    expect(seedScript.argv.slice(4, 7)).toEqual([`/workspace/${name}`, "refs/kube-seed/seed1", "main"]);
    expect(JSON.stringify(kube.execs)).not.toMatch(/GH_TOKEN|credential\.helper|clone/);
    // the agent sees the pod path, not the daemon path
    const open = acp.inputs[0] as any;
    expect(open.config.cwd).toBe(`/workspace/${name}`);
    // Paseo sees its own cwd
    expect(events.find((e) => e.type === "session.opened")).toMatchObject({ cwd: "/home/me/repo" });

    // the connector execs the agent command in that pod
    acp.connector!();
    expect(kube.streams.at(-1)!.pod).toBe(name);
    expect(kube.streams.at(-1)!.argv.slice(-1)).toEqual(["claude-agent-acp"]);
    expect(kube.streams.at(-1)!.argv.slice(0, 2)).toEqual(["sh", "-c"]); // wrapper: proxy env and shims on PATH

    await conn.send({
      type: "session.prompt", sessionId: "s1",
      prompt: { clientMessageId: "c1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi" }] } },
    });
    expect(events.some((e) => e.type === "timeline.item" && (e.item as any).text === "hello from pod")).toBe(true);

    await conn.send({ type: "session.close", requestId: "r2", sessionId: "s1" });
    expect(acp.closed).toBe(true);
    expect(kube.calls.slice(-2)).toEqual([`delete:sandbox/${name}`, `delete:pvc/workspace-${name}`]);
    expect(events.at(-1)).toEqual({ type: "request.completed", requestId: "r2" });
  });

  it("clips the session's capabilities to the ones the connection advertised", async () => {
    const { events, conn: p } = setup();
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s", config: sessionConfig(), history: "skip" });
    const opened = events.find((e) => e.type === "session.opened") as any;
    expect(opened.capabilities).toEqual([]); // setup() offers neither prompt.image nor session.persistence
    const full = await connectKube(
      { versions: [1], capabilities: ["prompt.image", "session.persistence"] },
      { config: ConfigSchema.parse({}), kube: new FakeKube(), acpProvider: new FakeAcp().provider, detectRepo: repo, seeder: fakeSeeder, catalog: async () => FALLBACK_CATALOG },
    );
    const seen: ProviderEvent[] = [];
    full.onEvent((e) => seen.push(e));
    await full.send({ type: "session.open", requestId: "r", sessionId: "s2", config: sessionConfig(), history: "skip" });
    expect((seen.find((e) => e.type === "session.opened") as any).capabilities).toEqual(["prompt.image"]);
  });

  it("answers permission requests for preapproved MCP tools without prompting, others reach Paseo", async () => {
    const ask = (conn: Awaited<ReturnType<typeof connectKube>>, id: string) =>
      conn.send({ type: "session.prompt", sessionId: id, prompt: { clientMessageId: "c", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "ask" }] } } });
    for (const [preapproved, expectPrompt] of [[true, false], [false, true]] as const) {
      const { acp, events, conn: p } = setup();
      const conn = await p;
      conn.onEvent((e) => events.push(e));
      const policy = preapproved ? { preapproved: [{ kind: "mcp" as const, server: "everything", tool: "echo" }] } : { preapproved: [{ kind: "mcp" as const, server: "other", tool: "echo" }] };
      await conn.send({ type: "session.open", requestId: "r", sessionId: "s", config: { ...sessionConfig(), toolPolicy: policy }, history: "skip" });
      await ask(conn, "s");
      await flush();
      expect(events.some((e) => e.type === "session.permission")).toBe(expectPrompt);
      const answered = acp.inputs.find((i) => i.type === "session.permission") as any;
      if (preapproved) expect(answered).toMatchObject({ permissionId: "permission:c1", response: { behavior: "allow", selectedActionId: "allow_once" } });
      else expect(answered).toBeUndefined();
    }
  });

  it("matches MCP tool names the way claude sanitizes server names", () => {
    const policy = { preapproved: [{ kind: "mcp" as const, server: "my.server", tool: "do" }] };
    expect(isPreapproved(policy, ["mcp__my_server__do"])).toBe(true);
    expect(isPreapproved(policy, ["Bash"])).toBe(false);
    expect(isPreapproved(undefined, ["mcp__my_server__do"])).toBe(false);
  });

  it("runs the configured image", async () => {
    const { kube, conn: p } = setup();
    const conn = await p;
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s", config: sessionConfig(), history: "skip" });
    expect((kube.applied[0] as any).spec.podTemplate.spec.containers[0].image).toBe("go:1");
  });

  it("deletes the sandbox and reports failure when the pod never becomes ready", async () => {
    const { kube, events, conn: p } = setup();
    kube.waitError = new Error("timed out");
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s", config: sessionConfig(), history: "skip" });
    expect(kube.calls.some((c) => c.startsWith("delete:sandbox/"))).toBe(true);
    expect(events[0]).toMatchObject({ type: "request.failed", requestId: "r", error: { message: expect.stringContaining("not ready") } });
  });

  it("fails and cleans up when the clone fails", async () => {
    const { kube, events, conn: p } = setup();
    kube.execResult = { code: 128, stdout: "", stderr: "auth failed" };
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s", config: sessionConfig(), history: "skip" });
    expect(events[0]).toMatchObject({ type: "request.failed" });
    expect(kube.calls.some((c) => c.startsWith("delete:sandbox/"))).toBe(true);
  });

  it("deletes every pod when the connection closes", async () => {
    const { kube, conn: p } = setup();
    const conn = await p;
    for (const id of ["a", "b"]) {
      await conn.send({ type: "session.open", requestId: id, sessionId: id, config: sessionConfig(), history: "skip" });
    }
    await conn.close();
    expect(kube.calls.filter((c) => c.startsWith("delete:sandbox/"))).toHaveLength(2);
  });
});

describe("kube connection edge cases", () => {
  const open = (conn: Awaited<ReturnType<typeof connectKube>>, id: string, env: Record<string, string> = {}) =>
    conn.send({ type: "session.open", requestId: `r-${id}`, sessionId: id, config: sessionConfig(env), history: "skip" });

  it("gives each session its own sandbox and routes inputs by session", async () => {
    const { kube, acp, conn: p } = setup();
    const conn = await p;
    await open(conn, "a");
    await open(conn, "b");
    const names = kube.applied.map((m: any) => m.metadata.name);
    expect(new Set(names).size).toBe(2);
    await conn.send({ type: "session.interrupt", requestId: "i", sessionId: "b" });
    expect(acp.inputs.at(-1)).toMatchObject({ type: "session.interrupt", sessionId: "b" });
    await conn.send({ type: "session.close", requestId: "c", sessionId: "a" });
    expect(kube.calls.filter((c) => c === `delete:sandbox/${names[0]}`)).toHaveLength(1);
    expect(kube.calls).not.toContain(`delete:sandbox/${names[1]}`);
  });

  it("rejects inputs for unknown sessions and after close", async () => {
    const { conn: p } = setup();
    const conn = await p;
    await expect(
      conn.send({ type: "session.interrupt", requestId: "i", sessionId: "nope" }),
    ).rejects.toThrow(/Unknown session/);
    await conn.close();
    await expect(open(conn, "x")).rejects.toThrow(/closed/);
  });

  it("closing an unknown session completes without touching the cluster", async () => {
    const { kube, events, conn: p } = setup();
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.close", requestId: "c", sessionId: "ghost" });
    expect(events).toEqual([{ type: "request.completed", requestId: "c" }]);
    expect(kube.calls).toEqual([]);
  });

  it("reports a failed delete on close instead of throwing", async () => {
    const { kube, events, conn: p } = setup();
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await open(conn, "s");
    kube.delete = async () => {
      throw new Error("forbidden");
    };
    await conn.send({ type: "session.close", requestId: "c", sessionId: "s" });
    expect(events.at(-1)).toMatchObject({ type: "request.failed", requestId: "c" });
  });

  it("cleans up when the agent rejects session.open", async () => {
    const kube = new FakeKube();
    const acp = new FakeAcp();
    const events: ProviderEvent[] = [];
    const failing = (c: Parameters<FakeAcp["provider"]>[0]) => {
      const reg = acp.provider(c);
      const connect = reg.connect.bind(reg);
      reg.connect = async (r) => {
        const inner = await connect(r);
        inner.send = async () => {
          throw new Error("agent crashed");
        };
        return inner;
      };
      return reg;
    };
    const conn = await connectKube(request, { config: ConfigSchema.parse({}), kube, acpProvider: failing, detectRepo: repo, seeder: fakeSeeder, catalog: async () => FALLBACK_CATALOG, sleep: async () => undefined, now: fakeClock() });
    conn.onEvent((e) => events.push(e));
    await open(conn, "s");
    expect(events.at(-1)).toMatchObject({ type: "request.failed", error: { message: expect.stringContaining("agent crashed") } });
    expect(acp.closed).toBe(true);
    expect(kube.calls.some((c) => c.startsWith("delete:sandbox/"))).toBe(true);
  });

  it("offers an agent-default model in the catalog so provider/model resolves", async () => {
    const { events, conn: p } = setup();
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "catalog", requestId: "k" });
    expect((events[0] as any).catalog).toMatchObject({ defaultModel: "default", defaultMode: "default", models: [{ id: "default" }] });
    // Paseo validates a requested mode against the catalog before the pod exists
    expect((events[0] as any).catalog.modes.map((m: any) => m.id)).toEqual(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
  });

  it("answers catalog and sessions requests locally", async () => {
    const { kube, events, conn: p } = setup();
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "catalog", requestId: "k" });
    await conn.send({ type: "sessions", requestId: "l" });
    expect(events.map((e) => e.type)).toEqual(["catalog", "sessions"]);
    expect(kube.calls).toEqual([]);
  });

  it("advertises tool policy support but does not forward the policy to the agent", async () => {
    const { acp, conn: p } = setup();
    const conn = await p;
    expect(conn.capabilities).not.toContain("permission.tool_policy"); // request did not offer it
    const offered = await connectKube(
      { versions: [1], capabilities: ["permission", "permission.tool_policy"] },
      { config: ConfigSchema.parse({}), kube: new FakeKube(), acpProvider: acp.provider, detectRepo: repo, seeder: fakeSeeder, catalog: async () => FALLBACK_CATALOG },
    );
    expect(offered.capabilities).toContain("permission.tool_policy");
    await offered.send({
      type: "session.open", requestId: "r", sessionId: "s",
      config: { ...sessionConfig(), toolPolicy: { preapproved: [{ kind: "mcp", server: "x", tool: "y" }] } },
      history: "skip",
    });
    expect((acp.inputs[0] as any).config.toolPolicy).toBeUndefined();
  });

  it("only advertises capabilities the caller offered", async () => {
    const conn = await connectKube({ versions: [1], capabilities: ["permission", "session.list"] }, {
      config: ConfigSchema.parse({}), kube: new FakeKube(), acpProvider: new FakeAcp().provider,
    });
    expect(conn.capabilities).toEqual(["permission"]);
    await expect(
      connectKube({ versions: [2], capabilities: [] }, { config: ConfigSchema.parse({}), kube: new FakeKube(), acpProvider: new FakeAcp().provider }),
    ).rejects.toThrow(/protocol/);
  });
});

describe("duplicated settings", () => {
  it("hides the adapter's own mode/model/thinking settings, which Paseo already shows as pickers", async () => {
    const { acp, events, conn: p } = setup();
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s1", config: sessionConfig(), history: "skip" });
    acp.emit({
      type: "session.config",
      sessionId: "s1",
      config: {
        models: [], modes: [], thinkingOptions: [],
        settings: [
          { type: "select", id: "mode", label: "Mode", value: "bypassPermissions", options: [{ label: "Bypass", value: "bypassPermissions" }] },
          { type: "toggle", id: "fast", label: "Fast", value: true },
        ],
      },
    });
    const config = events.find((e) => e.type === "session.config") as any;
    expect(config.config.settings.map((s: any) => s.id)).toEqual(["fast"]);
  });
});
