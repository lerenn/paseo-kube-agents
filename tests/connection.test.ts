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
