import { describe, expect, it } from "vitest";
import type { ProviderEvent, ProviderInput, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { connectKube } from "../server/connection.js";
import { PodRegistry } from "../server/registry.js";
import { sessionLabel } from "../server/sandbox.js";
import { ConfigSchema } from "../shared/settings.js";
import { FakeAcp, FakeKube, fakeSeeder } from "./fakes.js";

const MIN = 60_000;
const repo = async () => ({ url: "https://github.com/lerenn/x", branch: "main" });
const cfg = (): ProviderSessionConfig => ({ cwd: "/home/me/repo", env: {}, mcpServers: {}, settings: {}, persist: false });
const flush = () => new Promise((r) => setTimeout(r, 5));
const promptInput = (sessionId: string, text = "hi"): ProviderInput => ({
  type: "session.prompt",
  sessionId,
  prompt: { clientMessageId: `c-${text}`, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } },
});

async function setup(settings: object = {}, deps: object = {}) {
  const kube = new FakeKube();
  const acp = new FakeAcp();
  const registry = new PodRegistry();
  const events: ProviderEvent[] = [];
  let clock = 5_000_000;
  let tick: () => void = () => undefined;
  const conn = await connectKube(
    { versions: [1], capabilities: ["prompt.message"] },
    {
      config: ConfigSchema.parse({ podIdleMinutes: 30, readyTimeoutSeconds: 1, ...settings }),
      kube,
      acpProvider: acp.provider,
      detectRepo: repo,
      seeder: fakeSeeder, eager: true,
      registry,
      sleep: async () => undefined,
      now: () => clock++, // every read moves the clock a little, so a pod that never becomes ready times out
      ticker: (fn) => {
        tick = fn;
        return () => undefined;
      },
      ...deps,
    },
  );
  conn.onEvent((e) => events.push(e));
  await conn.send({ type: "session.open", requestId: "r", sessionId: "s1", config: cfg(), history: "skip" });
  return {
    kube, acp, registry, events, conn,
    advance: (ms: number) => void (clock += ms),
    tick: async () => { tick(); await flush(); },
    notices: () => events.filter((e) => e.type === "session.notice").map((e: any) => e.notice.title as string),
    opens: () => acp.inputs.filter((i) => i.type === "session.open") as any[],
  };
}

describe("idle suspension", () => {
  it("deletes an idle agent's pod after podIdleMinutes and keeps its volume", async () => {
    const t = await setup();
    await t.conn.send(promptInput("s1")); // an agent in use, not a draft
    t.advance(29 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
    t.advance(2 * MIN);
    await t.tick();
    const suspend = t.kube.patches2.at(-1)!.patch;
    expect(suspend.spec.operatingMode).toBe("Suspended");
    expect(suspend.spec.shutdownTime).toBeNull(); // an agent in use never expires: its volume goes only on archive
    expect(t.kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    expect(t.registry.list()[0]!.state).toBe("suspended");
    expect(t.notices().at(-1)).toMatch(/Pod suspended/);
    expect(t.acp.closed).toBe(true);
  });

  it("keeps an unused draft's volume only an hour when it sits idle; a prompt removes every expiry", async () => {
    const draft = await setup();
    draft.advance(31 * MIN);
    await draft.tick();
    const suspend = draft.kube.patches2.at(-1)!.patch;
    expect(Date.parse(suspend.spec.shutdownTime) - Date.now()).toBeLessThan(2 * 3600 * 1000);
    await draft.conn.send(promptInput("s1"));
    expect(draft.kube.patches2.filter((p) => p.patch.spec?.operatingMode === "Running").at(-1)!.patch.spec.shutdownTime).not.toBeNull(); // still a draft while it wakes
    expect(draft.kube.patches2.at(-1)!.patch).toEqual({ spec: { shutdownTime: null } }); // then the first prompt removes every expiry
    draft.advance(31 * MIN);
    await draft.tick();
    expect(draft.kube.patches2.at(-1)!.patch.spec.shutdownTime).toBeNull();
  });

  it("does not suspend an agent that is working or waiting on a permission, or when disabled", async () => {
    const busy = await setup();
    busy.acp.emit({ type: "session.turn", sessionId: "s1", turnId: "t", state: "started" });
    busy.advance(2 * 60 * MIN);
    await busy.tick();
    expect(busy.registry.list()[0]!.state).toBe("running");
    busy.acp.emit({ type: "session.turn", sessionId: "s1", turnId: "t", state: "completed" });
    busy.acp.emit({ type: "session.permission", sessionId: "s1", request: { id: "p", name: "Bash", kind: "tool", actions: [{ id: "x", label: "No", behavior: "deny" }] } });
    busy.advance(2 * 60 * MIN);
    await busy.tick();
    expect(busy.registry.list()[0]!.state).toBe("running");
    busy.acp.emit({ type: "session.permission_resolved", sessionId: "s1", permissionId: "p" });
    busy.advance(31 * MIN);
    await busy.tick();
    expect(busy.registry.list()[0]!.state).toBe("suspended");

    for (const settings of [{ podIdleMinutes: 0 }, { storage: { mode: "ephemeral", size: "10Gi" } }]) {
      const off = await setup(settings);
      off.advance(24 * 60 * MIN);
      await off.tick();
      expect(off.registry.list()[0]!.state).toBe("running");
    }
  });

  it("an input brings the pod back on the same volume and resumes the session before delivering it", async () => {
    const t = await setup({ image: "node:23" });
    t.advance(31 * MIN);
    await t.tick();
    const clonesBefore = t.kube.execs.filter((e) => e.argv[2]?.includes("git init")).length;
    t.acp.inputs.length = 0;
    await t.conn.send(promptInput("s1", "wake up"));
    const resume = t.kube.patches2.filter((p) => p.patch.spec?.operatingMode === "Running").at(-1)!.patch;
    expect(resume.spec.operatingMode).toBe("Running");
    expect(resume.spec.podTemplate.spec.containers[0].image).toBe("node:23"); // current settings, not the old image
    expect(t.kube.execs.filter((e) => e.argv[2]?.includes("git init")).length).toBe(clonesBefore); // the volume still has the workspace
    const types = t.acp.inputs.map((i: any) => i.type);
    expect(types).toEqual(["session.open", "session.prompt"]); // reopen first, then the message
    expect(t.opens()[0].persistence).toEqual({ version: 1, data: { sessionId: "native-s1" } });
    expect(t.opens()[0].requestId).toMatch(/^recover-/);
    expect(t.registry.list()[0]!.state).toBe("running");
    expect(t.notices()).toEqual(expect.arrayContaining(["Resuming the pod...", "Pod resumed"]));
    // Paseo never saw its session die or reopen
    expect(t.events.some((e) => e.type === "session.runtime_failed" || e.type === "session.closed")).toBe(false);
    expect(t.events.filter((e) => e.type === "session.opened")).toHaveLength(1);
  });

  it("queues inputs that arrive during a resume behind it, with one resume", async () => {
    const t = await setup();
    t.advance(31 * MIN);
    await t.tick();
    t.acp.inputs.length = 0;
    await Promise.all([t.conn.send(promptInput("s1", "one")), t.conn.send(promptInput("s1", "two"))]);
    expect(t.kube.patches2.filter((p) => p.patch.spec?.operatingMode === "Running")).toHaveLength(1);
    const delivered = t.acp.inputs.filter((i: any) => i.type === "session.prompt").map((i: any) => i.prompt.input.content[0].text);
    expect(delivered).toEqual(["one", "two"]);
    expect(t.acp.inputs[0]!.type).toBe("session.open");
  });

  it("explains a resume that cannot be scheduled (volume bound to a zone without capacity) and retries on the next input", async () => {
    const t = await setup();
    t.advance(31 * MIN);
    await t.tick();
    t.kube.pods = [{ uid: "u", ready: false, terminating: false, problem: "Pod cannot be scheduled: volume node affinity conflict" }];
    await expect(t.conn.send(promptInput("s1", "hello"))).rejects.toThrow(/could not resume the pod.*volume node affinity conflict.*Send a message again/s);
    expect(t.registry.list()[0]!.state).toBe("suspended");
    expect(t.notices()).toContain("Pod cannot be scheduled: volume node affinity conflict");
    expect(t.kube.patches2.at(-1)!.patch.spec.operatingMode).toBe("Suspended"); // released again, nothing left pending
    t.kube.pods = [{ uid: "ok", ready: true, terminating: false }];
    await t.conn.send(promptInput("s1", "again"));
    expect(t.registry.list()[0]!.state).toBe("running");
  });

  it("does not wake a pod to interrupt it, and archives a suspended agent without resuming it", async () => {
    const t = await setup();
    t.advance(31 * MIN);
    await t.tick();
    await t.conn.send({ type: "session.interrupt", requestId: "i", sessionId: "s1" });
    expect(t.kube.patches2.filter((p) => p.patch.spec?.operatingMode === "Running")).toHaveLength(0);
    expect(t.events.at(-1)).toEqual({ type: "request.completed", requestId: "i" });
    await t.conn.send({ type: "session.close", requestId: "c", sessionId: "s1" });
    expect(t.kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([expect.stringMatching(/^delete:sandbox\//), expect.stringMatching(/^delete:pvc\/workspace-/)]);
    expect(t.registry.list()).toEqual([]);
    expect(t.kube.patches2.filter((p) => p.patch.spec?.operatingMode === "Running")).toHaveLength(0);
  });
});

describe("finding an agent's sandbox again", () => {
  it("adopts a suspended sandbox on session.open (plugin restart), resuming it from the saved handle", async () => {
    const kube = new FakeKube();
    kube.sandboxes = [{ name: "pka-x-1", labels: { "paseo.sh/session": sessionLabel("s1") }, annotations: {}, operatingMode: "Suspended" }];
    const acp = new FakeAcp();
    const conn = await connectKube({ versions: [1], capabilities: [] }, { config: ConfigSchema.parse({}), kube, acpProvider: acp.provider, detectRepo: repo, seeder: fakeSeeder, eager: true, sleep: async () => undefined, now: () => 1 });
    kube.hasClone = true; // the volume has the workspace
    const persistence = { version: 1, data: { sessionId: "native-s1" } };
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s1", config: cfg(), history: "skip", persistence });
    expect(kube.applied).toHaveLength(0); // no new sandbox
    expect(kube.patches2[0]!.patch.spec.operatingMode).toBe("Running");
    expect((acp.inputs[0] as any).persistence).toEqual(persistence);
    expect(kube.execs.some((e) => e.argv[2]?.includes("git init"))).toBe(false); // not reseeded
    await conn.send({ type: "session.close", requestId: "c", sessionId: "s1" });
    expect(kube.calls).toContain("delete:sandbox/pka-x-1");
  });

  it("keeps an adopted sandbox (and the agent's files) when the reopen fails", async () => {
    const kube = new FakeKube();
    kube.sandboxes = [{ name: "pka-x-1", labels: { "paseo.sh/session": sessionLabel("s1") }, annotations: {}, operatingMode: "Running" }];
    kube.waitError = new Error("api down");
    const conn = await connectKube({ versions: [1], capabilities: [] }, { config: ConfigSchema.parse({ readyTimeoutSeconds: 1 }), kube, acpProvider: new FakeAcp().provider, detectRepo: repo, seeder: fakeSeeder, eager: true, sleep: async () => undefined, now: (() => { let t = 0; return () => (t += 1000); })() });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s1", config: cfg(), history: "skip" });
    expect(events[0]!.type).toBe("request.failed");
    expect(kube.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });
});

describe("finding an agent by its own session handle", () => {
  it("adopts the sandbox when Paseo reopens the session under a new id but the same handle", async () => {
    const kube = new FakeKube();
    kube.sandboxes = [{ name: "pka-x-1", labels: { "paseo.sh/native": sessionLabel("native-old") }, annotations: {}, operatingMode: "Suspended" }];
    kube.hasClone = true;
    const acp = new FakeAcp();
    const conn = await connectKube({ versions: [1], capabilities: [] }, { config: ConfigSchema.parse({}), kube, acpProvider: acp.provider, detectRepo: repo, seeder: fakeSeeder, eager: true, sleep: async () => undefined, now: () => 1 });
    await conn.send({ type: "session.open", requestId: "r", sessionId: "brand-new-id", config: cfg(), history: "skip", persistence: { version: 1, data: { sessionId: "native-old" } } });
    expect(kube.applied).toHaveLength(0);
    expect(kube.patches2[0]!.patch.spec.operatingMode).toBe("Running");
  });

  it("labels the sandbox with the handle Paseo saved, and keeps the agent process's own handle privately", async () => {
    const t = await setup();
    await flush();
    expect((t.kube.applied[0] as any).metadata.labels["paseo.sh/native"]).toBe(sessionLabel("s1")); // the minted handle
    const own = t.kube.patches2.find((p) => p.patch.metadata?.annotations?.["paseo.sh/acp-handle"]);
    expect(JSON.parse(own!.patch.metadata.annotations["paseo.sh/acp-handle"])).toEqual({ version: 1, data: { sessionId: "native-s1" } });
    // Paseo is only ever shown the minted handle
    const opened = t.events.find((e) => e.type === "session.opened") as any;
    expect(opened.persistence).toEqual({ version: 1, data: { sessionId: "s1" } });
  });

  it("resumes the agent process's own conversation from the sandbox, whichever id Paseo reopens it under", async () => {
    const kube = new FakeKube();
    kube.sandboxes = [{ name: "pka-x-1", labels: { "paseo.sh/native": sessionLabel("s1") }, annotations: { "paseo.sh/acp-handle": JSON.stringify({ version: 1, data: { sessionId: "native-private" } }) }, operatingMode: "Suspended" }];
    kube.hasClone = true;
    const acp = new FakeAcp();
    const conn = await connectKube({ versions: [1], capabilities: [] }, { config: ConfigSchema.parse({}), kube, acpProvider: acp.provider, detectRepo: repo, seeder: fakeSeeder, eager: true, sleep: async () => undefined, now: () => 1 });
    await conn.send({ type: "session.open", requestId: "r", sessionId: "new-paseo-id", config: cfg(), history: "skip", persistence: { version: 1, data: { sessionId: "s1" } } });
    expect((acp.inputs[0] as any).persistence).toEqual({ version: 1, data: { sessionId: "native-private" } });
  });
});

describe("claiming a warm pod for a new agent", () => {
  it("uses the claimed sandbox instead of creating one, and counts as a request", async () => {
    const kube = new FakeKube();
    let requests = 0;
    const claims: string[] = [];
    const conn = await connectKube({ versions: [1], capabilities: [] }, {
      config: ConfigSchema.parse({}),
      kube,
      acpProvider: new FakeAcp().provider,
      detectRepo: repo,
      seeder: fakeSeeder, eager: true,
      sleep: async () => undefined,
      pool: { noteRequest: () => void requests++, claim: async (id) => (claims.push(id), "pka-warm-7") },
    });
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s1", config: cfg(), history: "skip" });
    expect(requests).toBe(1);
    expect(claims).toEqual(["s1"]);
    expect(kube.applied).toHaveLength(0);
    expect(kube.execs.some((e) => e.pod === "pka-warm-7")).toBe(true);
  });

  it("creates a cold sandbox when no warm pod is ready, and survives a pool error", async () => {
    for (const claim of [async () => null, async () => { throw new Error("boom"); }]) {
      const kube = new FakeKube();
      const conn = await connectKube({ versions: [1], capabilities: [] }, { config: ConfigSchema.parse({}), kube, acpProvider: new FakeAcp().provider, detectRepo: repo, seeder: fakeSeeder, eager: true, sleep: async () => undefined, pool: { noteRequest: () => undefined, claim } });
      await conn.send({ type: "session.open", requestId: "r", sessionId: "s1", config: cfg(), history: "skip" });
      expect(kube.applied).toHaveLength(1);
    }
  });
});
