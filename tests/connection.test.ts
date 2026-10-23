import { describe, expect, it } from "vitest";
import type { ProviderEvent, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { ConfigSchema } from "../server/config.js";
import { connectKube } from "../server/connection.js";
import { FakeAcp, FakeKube } from "./fakes.js";

const request = { versions: [1], capabilities: ["prompt.message", "permission"] };
const sessionConfig = (env: Record<string, string> = {}): ProviderSessionConfig => ({
  cwd: "/home/me/repo", env, mcpServers: {}, settings: {}, persist: false,
});
const repo = async () => ({ url: "https://github.com/lerenn/x", branch: "main" });

function setup(overrides: Partial<ReturnType<typeof ConfigSchema.parse>> = {}) {
  const kube = new FakeKube();
  const acp = new FakeAcp();
  const config = ConfigSchema.parse({ templates: { go: { image: "go:1" } }, ...overrides });
  const events: ProviderEvent[] = [];
  const conn = connectKube(request, { config, kube, acpProvider: acp.provider, detectRepo: repo });
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
    expect(kube.calls.slice(0, 3)).toEqual(["apply", `wait:sandbox/${name}`, "exec"]);
    // clone happens in the pod, then the agent sees the pod path, not the daemon path
    expect(kube.execs[0]!.argv.slice(-3)).toEqual(["main", "https://github.com/lerenn/x", `/workspace/${name}`]);
    const open = acp.inputs[0] as any;
    expect(open.config.cwd).toBe(`/workspace/${name}`);
    // Paseo sees its own cwd
    expect(events.find((e) => e.type === "session.opened")).toMatchObject({ cwd: "/home/me/repo" });

    // the connector execs the agent command in that pod
    acp.connector!();
    expect(kube.streams[0]).toEqual({ pod: name, argv: ["claude-agent-acp"] });

    await conn.send({
      type: "session.prompt", sessionId: "s1",
      prompt: { clientMessageId: "c1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi" }] } },
    });
    expect(events.some((e) => e.type === "timeline.item" && (e.item as any).text === "hello from pod")).toBe(true);

    await conn.send({ type: "session.close", requestId: "r2", sessionId: "s1" });
    expect(acp.closed).toBe(true);
    expect(kube.calls.at(-1)).toBe(`delete:sandbox/${name}`);
    expect(events.at(-1)).toEqual({ type: "request.completed", requestId: "r2" });
  });

  it("selects the pod template from PASEO_KUBE_TEMPLATE", async () => {
    const { kube, conn: p } = setup();
    const conn = await p;
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s", config: sessionConfig({ PASEO_KUBE_TEMPLATE: "go" }), history: "skip" });
    expect((kube.applied[0] as any).spec.podTemplate.spec.containers[0].image).toBe("go:1");
  });

  it("deletes the sandbox and reports failure when the pod never becomes ready", async () => {
    const { kube, events, conn: p } = setup();
    kube.waitError = new Error("timed out");
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s", config: sessionConfig(), history: "skip" });
    expect(kube.calls.some((c) => c.startsWith("delete:sandbox/"))).toBe(true);
    expect(events[0]).toMatchObject({ type: "request.failed", requestId: "r", error: { message: expect.stringContaining("timed out") } });
  });

  it("fails and cleans up when the clone fails", async () => {
    const { kube, events, conn: p } = setup();
    kube.execResult = { code: 128, stdout: "", stderr: "auth failed" };
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s", config: sessionConfig(), history: "skip" });
    expect(events[0]).toMatchObject({ type: "request.failed" });
    expect(kube.calls.at(-1)).toMatch(/^delete:sandbox\//);
  });

  it("deletes every pod when the connection closes", async () => {
    const { kube, conn: p } = setup();
    const conn = await p;
    for (const id of ["a", "b"]) {
      await conn.send({ type: "session.open", requestId: id, sessionId: id, config: sessionConfig(), history: "skip" });
    }
    await conn.close();
    expect(kube.calls.filter((c) => c.startsWith("delete:"))).toHaveLength(2);
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
    const conn = await connectKube(request, { config: ConfigSchema.parse({}), kube, acpProvider: failing, detectRepo: repo });
    conn.onEvent((e) => events.push(e));
    await open(conn, "s");
    expect(events.at(-1)).toMatchObject({ type: "request.failed", error: { message: expect.stringContaining("agent crashed") } });
    expect(acp.closed).toBe(true);
    expect(kube.calls.at(-1)).toMatch(/^delete:sandbox\//);
  });

  it("fails fast on an unknown template without creating anything", async () => {
    const { kube, events, conn: p } = setup();
    const conn = await p;
    conn.onEvent((e) => events.push(e));
    await open(conn, "s", { PASEO_KUBE_TEMPLATE: "rust" });
    expect(kube.applied).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: "request.failed", error: { message: expect.stringContaining("Known templates") } });
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
