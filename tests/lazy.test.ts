import { describe, expect, it } from "vitest";
import type { ProviderEvent, ProviderInput, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { connectKube } from "../server/connection.js";
import { FALLBACK_CATALOG } from "../server/catalog.js";
import { OrphanReaper, readLiveHandles } from "../server/orphans.js";
import { sessionLabel } from "../server/sandbox.js";
import { ConfigSchema } from "../shared/settings.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAcp, FakeKube, fakeSeeder } from "./fakes.js";

const repo = async () => ({ url: "https://github.com/lerenn/x", branch: "main" });
const cfg = (env: Record<string, string> = {}): ProviderSessionConfig => ({ cwd: "/home/me/repo", env, mcpServers: {}, settings: {}, persist: false });
const prompt = (sessionId: string): ProviderInput => ({ type: "session.prompt", sessionId, prompt: { clientMessageId: "c", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi" }] } } });

async function setup(deps: object = {}) {
  const kube = new FakeKube();
  const acp = new FakeAcp();
  const events: ProviderEvent[] = [];
  const conn = await connectKube({ versions: [1], capabilities: ["prompt.message", "session.persistence"] }, {
    config: ConfigSchema.parse({}), kube, acpProvider: acp.provider, detectRepo: repo, seeder: fakeSeeder,
    catalog: async () => FALLBACK_CATALOG, sleep: async () => undefined, now: () => 1, ...deps,
  });
  conn.onEvent((e) => events.push(e));
  return { kube, acp, events, conn };
}

describe("opening a session costs nothing", () => {
  it("answers the open from the catalog without creating a sandbox, claim or pod", async () => {
    const { kube, events, acp, conn } = await setup();
    await conn.send({ type: "session.open", requestId: "r", sessionId: "draft", config: cfg(), history: "skip" });
    expect(kube.applied).toHaveLength(0);
    expect(kube.calls.filter((c) => !c.startsWith("pod:"))).toEqual([]);
    expect(acp.inputs).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["session.opened", "session.config", "session.ready"]);
    const config = events[1] as any;
    expect(config.config.models.map((m: any) => m.id)).toEqual(["default"]);
    expect(config.config.modes.length).toBeGreaterThan(0);
  });

  it("closing a draft that never ran touches nothing in the cluster", async () => {
    const { kube, conn, events } = await setup();
    await conn.send({ type: "session.open", requestId: "r", sessionId: "draft", config: cfg(), history: "skip" });
    await conn.send({ type: "session.close", requestId: "c", sessionId: "draft" });
    await conn.close();
    expect(kube.calls).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "request.completed", requestId: "c" });
  });

  it("the open gives Paseo a stable handle; the first message creates the sandbox, starts the agent, then delivers", async () => {
    const { kube, events, acp, conn } = await setup({ daemonId: "srv_ME" });
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s1", config: cfg({ PASEO_KUBE_AGENT_ID: "agent-1" }), history: "skip" });
    await conn.send(prompt("s1"));
    expect(kube.applied).toHaveLength(1);
    expect((kube.applied[0] as any).metadata.labels).toMatchObject({ "paseo.sh/daemon": "srv_ME", "paseo.sh/agent": "agent-1" });
    expect(acp.inputs.map((i: any) => i.type)).toEqual(["session.open", "session.prompt"]);
    expect(acp.inputs[0]).toMatchObject({ requestId: expect.stringMatching(/^recover-/) });
    // Paseo saved the handle it was given when the session opened (it only saves it from session.opened), and
    // never sees the agent process's own handle
    const opened = events.filter((e) => e.type === "session.opened") as any[];
    expect(opened).toHaveLength(1);
    expect(opened[0].persistence).toEqual({ version: 1, data: { sessionId: "s1" } });
    expect(events.some((e) => e.type === "session.persistence")).toBe(false);
    expect(events.map((e: any) => e.notice?.title).filter(Boolean)).toEqual(expect.arrayContaining(["Starting the pod...", "Pod started"]));
  });

  it("a daemon restart reopens a suspended agent without waking it; its next message does", async () => {
    const kube = new FakeKube();
    kube.sandboxes = [{ name: "pka-x-1", labels: { "paseo.sh/session": sessionLabel("old-id") }, annotations: {}, operatingMode: "Suspended" }];
    kube.hasClone = true;
    const { acp, conn } = await setup({ kube });
    await conn.send({ type: "session.open", requestId: "r", sessionId: "old-id", config: cfg(), history: "skip", persistence: { version: 1, data: { sessionId: "native-s1" } } });
    expect(kube.patches2).toHaveLength(0);
    expect(acp.inputs).toHaveLength(0);
    await conn.send(prompt("old-id"));
    expect(kube.patches2.find((p) => p.patch.spec?.operatingMode === "Running")).toBeDefined();
    expect(kube.applied).toHaveLength(0);
    expect((acp.inputs[0] as any).persistence).toEqual({ version: 1, data: { sessionId: "native-s1" } });
  });

  it("removes a sandbox it just created when the first start fails, so the retry starts clean", async () => {
    const kube = new FakeKube();
    kube.pods = [{ uid: "u", ready: false, terminating: false, problem: "Pod cannot be scheduled: no capacity" }];
    let t = 0;
    const { conn } = await setup({ kube, config: ConfigSchema.parse({ readyTimeoutSeconds: 1 }), now: () => (t += 1) });
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s1", config: cfg(), history: "skip" });
    await expect(conn.send(prompt("s1"))).rejects.toThrow(/could not start the pod.*no capacity/s);
    expect(kube.calls.filter((c) => c.startsWith("delete:sandbox/"))).toHaveLength(1);
    kube.pods = [{ uid: "ok", ready: true, terminating: false }];
    await conn.send(prompt("s1"));
    expect(kube.applied).toHaveLength(2); // a fresh sandbox the second time
  });
});

describe("unlabelled sweep", () => {
  const NOW = Date.parse("2026-10-24T12:00:00Z");
  const old = new Date(NOW - 60 * 60_000).toISOString();
  const young = new Date(NOW - 5 * 60_000).toISOString();
  const sb = (name: string, labels: Record<string, string>, createdAt = old) => ({ name, labels: { "app.kubernetes.io/managed-by": "paseo-kube-agents", ...labels }, annotations: {}, operatingMode: "Running" as const, createdAt });

  function reaper(sweepUnlabelled: boolean, handles: Set<string> | null, active: string[] = []) {
    const kube = new FakeKube();
    const logs: string[] = [];
    const r = new OrphanReaper({
      getConfig: async () => ConfigSchema.parse({ sweepUnlabelled }), kubeFor: () => kube, daemonId: "srv_ME",
      agentState: async () => "alive", now: () => NOW, log: (l) => logs.push(l),
      liveHandles: async () => handles, activeSandboxes: () => new Set(active),
    });
    return { kube, logs, r };
  }

  it("deletes old unlabelled pka- sandboxes (and claims) that match no agent, and logs each", async () => {
    const { kube, logs, r } = reaper(true, new Set([sessionLabel("native-live")]));
    kube.sandboxes = [
      sb("pka-draft", {}), // never ran: no handle
      sb("pka-orphan", { "paseo.sh/native": sessionLabel("native-gone") }),
      sb("pka-agent", { "paseo.sh/native": sessionLabel("native-live") }), // belongs to a live agent
      sb("pka-young", {}, young),
      sb("pka-running-here", {}),
      sb("not-ours", {}),
      sb("pka-other-daemon", { "paseo.sh/daemon": "srv_OTHER" }),
    ];
    kube.claims = [{ name: "workspace-pka-gone", labels: {}, createdAt: old }, { name: "workspace-pka-agent", labels: {}, createdAt: old }, { name: "workspace-unrelated", labels: {}, createdAt: old }];
    const status = await r.run();
    const deleted = kube.calls.filter((c) => c.startsWith("delete:sandbox/")).sort();
    expect(deleted).toEqual(["delete:sandbox/pka-draft", "delete:sandbox/pka-orphan", "delete:sandbox/pka-running-here"]);
    expect(logs.filter((l) => l.includes("deleting unlabelled sandbox"))).toHaveLength(3);
    expect(kube.calls).toContain("delete:pvc/workspace-pka-gone");
    expect(kube.calls).not.toContain("delete:pvc/workspace-pka-agent");
    expect(kube.calls).not.toContain("delete:pvc/workspace-unrelated");
    expect(status.removed).toBe(4); // three sandboxes and one volume claim without a sandbox
  });

  it("never sweeps what this plugin is running, and does nothing when switched off or when the agents cannot be read", async () => {
    const running = reaper(true, new Set(), ["pka-mine"]);
    running.kube.sandboxes = [sb("pka-mine", {})];
    await running.r.run();
    expect(running.kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);

    const off = reaper(false, new Set());
    off.kube.sandboxes = [sb("pka-draft", {})];
    expect((await off.r.run()).unlabelled).toEqual(["pka-draft"]);
    expect(off.kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);

    const unknown = reaper(true, null);
    unknown.kube.sandboxes = [sb("pka-draft", {})];
    await unknown.r.run();
    expect(unknown.kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
  });

  it("reads the live agents' session handles from the daemon's store, skipping archived ones", () => {
    const home = mkdtempSync(join(tmpdir(), "kube-store-"));
    mkdirSync(join(home, "agents", "proj"), { recursive: true });
    const rec = (handle: string, archivedAt?: string) => JSON.stringify({ archivedAt, persistence: { metadata: { pluginProviderPersistence: { data: { sessionId: handle } } } } });
    writeFileSync(join(home, "agents", "proj", "a.json"), rec("live"));
    writeFileSync(join(home, "agents", "proj", "b.json"), rec("archived", "2026-01-01"));
    writeFileSync(join(home, "agents", "proj", "c.json"), "{broken");
    expect(readLiveHandles(home)).toEqual(new Set([sessionLabel("live")]));
    expect(readLiveHandles(join(home, "nowhere"))).toBeNull();
  });
});
