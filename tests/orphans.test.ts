import { describe, expect, it } from "vitest";
import { OrphanReaper, paseoAgentState, type AgentState } from "../server/orphans.js";
import { buildSandbox, claimPatch, resumePatch, suspendPatch, usedPatch } from "../server/sandbox.js";
import { readDaemonId } from "../server/daemon.js";
import { connectKube } from "../server/connection.js";
import { ConfigSchema } from "../shared/settings.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAcp, FakeKube, fakeSeeder } from "./fakes.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-24T12:00:00Z");
const old = new Date(NOW - 60 * MIN).toISOString();
const fresh = new Date(NOW - 1 * MIN).toISOString();
const sandbox = (name: string, labels: Record<string, string>, createdAt = old) => ({ name, labels, annotations: {}, operatingMode: "Running" as const, createdAt });

function setup(states: Record<string, AgentState>, daemonId: string | null = "srv_ME") {
  const kube = new FakeKube();
  const logs: string[] = [];
  const asked: string[] = [];
  const reaper = new OrphanReaper({
    getConfig: async () => ConfigSchema.parse({}),
    kubeFor: () => kube,
    daemonId: daemonId ?? undefined,
    agentState: async (id) => (asked.push(id), states[id] ?? "unknown"),
    now: () => NOW,
    log: (l) => logs.push(l),
  });
  return { kube, logs, asked, reaper };
}

describe("orphan reaper", () => {
  it("deletes sandboxes (and claims) whose agent is gone or archived, and logs each deletion", async () => {
    const { kube, logs, reaper } = setup({ a1: "gone", a2: "alive" });
    kube.sandboxes = [sandbox("sb-gone", { "paseo.sh/daemon": "srv_ME", "paseo.sh/agent": "a1" }), sandbox("sb-alive", { "paseo.sh/daemon": "srv_ME", "paseo.sh/agent": "a2" })];
    const status = await reaper.run();
    expect(kube.calls.filter((c) => c.startsWith("delete:"))).toEqual(["delete:sandbox/sb-gone", "delete:pvc/workspace-sb-gone"]);
    expect(logs).toEqual([expect.stringContaining("deleting sandbox sb-gone (agent a1 is gone or archived)")]);
    expect(status).toMatchObject({ removed: 1, removedTotal: 1, lastRunAt: new Date(NOW).toISOString() });
  });

  it("leaves alone: unknown agent state, young resources, other daemons' resources, and resources without an agent label", async () => {
    const { kube, asked, reaper } = setup({ a1: "unknown", a2: "gone", a3: "gone" });
    kube.sandboxes = [
      sandbox("unknown", { "paseo.sh/daemon": "srv_ME", "paseo.sh/agent": "a1" }), // Paseo could not be asked
      sandbox("young", { "paseo.sh/daemon": "srv_ME", "paseo.sh/agent": "a2" }, fresh), // within the grace period
      sandbox("other-daemon", { "paseo.sh/daemon": "srv_OTHER", "paseo.sh/agent": "a3" }),
      sandbox("draft", { "paseo.sh/daemon": "srv_ME" }), // no agent: a draft, handled by its one-hour expiry
    ];
    await reaper.run();
    expect(kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    expect(asked).toEqual(["a1"]); // never even asked about the other daemon's agent or the young one
  });

  it("reports unlabelled plugin sandboxes without deleting them", async () => {
    const { kube, logs, reaper } = setup({});
    kube.sandboxes = [sandbox("legacy", { "app.kubernetes.io/managed-by": "paseo-kube-agents" })];
    const status = await reaper.run();
    expect(status.unlabelled).toEqual(["legacy"]);
    expect(logs[0]).toContain("without a daemon label are left alone: legacy");
    expect(kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    await reaper.run();
    expect(logs).toHaveLength(1); // told once, not every ten minutes
  });

  it("deletes a volume claim whose sandbox is gone, but not one whose sandbox exists", async () => {
    const { kube, reaper } = setup({});
    kube.sandboxes = [sandbox("sb-1", { "paseo.sh/daemon": "srv_ME" })];
    kube.claims = [
      { name: "workspace-sb-1", labels: { "paseo.sh/daemon": "srv_ME" }, createdAt: old },
      { name: "workspace-sb-dead", labels: { "paseo.sh/daemon": "srv_ME" }, createdAt: old },
      { name: "workspace-other", labels: { "paseo.sh/daemon": "srv_OTHER" }, createdAt: old },
    ];
    await reaper.run();
    expect(kube.calls.filter((c) => c.startsWith("delete:"))).toEqual(["delete:pvc/workspace-sb-dead"]);
  });

  it("does nothing, and says so, without a daemon id", async () => {
    const { kube, reaper } = setup({ a1: "gone" }, null);
    kube.sandboxes = [sandbox("sb", { "paseo.sh/daemon": "srv_ME", "paseo.sh/agent": "a1" })];
    const status = await reaper.run();
    expect(status.error).toMatch(/daemon id unknown/);
    expect(kube.calls).toEqual([]);
  });

  it("keeps its previous result and reports the error when the cluster cannot be read", async () => {
    const { kube, reaper } = setup({});
    kube.listSandboxes = async () => {
      throw new Error("api down");
    };
    const status = await reaper.run();
    expect(status.error).toBe("api down");
    expect(status.removed).toBe(0);
  });

  it("runs once at a time", async () => {
    const { kube, reaper } = setup({});
    let calls = 0;
    const original = kube.listSandboxes.bind(kube);
    kube.listSandboxes = async (s: string) => (calls++, original(s));
    await Promise.all([reaper.run(), reaper.run()]);
    expect(calls).toBeLessThanOrEqual(3); // one pass (three lists), not two
  });
});

describe("labels and expiry", () => {
  const config = ConfigSchema.parse({});
  it("labels the sandbox and its volume claim with the daemon and the agent", () => {
    const sb = buildSandbox({ name: "n", sessionId: "s", config, daemonId: "srv_ME", agentId: "agent-1" }) as any;
    expect(sb.metadata.labels).toMatchObject({ "paseo.sh/daemon": "srv_ME", "paseo.sh/agent": "agent-1" });
    expect(sb.spec.volumeClaimTemplates[0].metadata.labels).toEqual({ "paseo.sh/daemon": "srv_ME", "paseo.sh/agent": "agent-1" });
    expect(sb.spec.podTemplate.metadata.labels).not.toHaveProperty("paseo.sh/daemon"); // the pod only carries the NetworkPolicy label
  });

  it("warm pool sandboxes carry the daemon but no agent, until claimed", () => {
    const sb = buildSandbox({ name: "n", sessionId: "", config, pool: true, daemonId: "srv_ME" }) as any;
    expect(sb.metadata.labels["paseo.sh/daemon"]).toBe("srv_ME");
    expect(sb.metadata.labels["paseo.sh/agent"]).toBeUndefined();
    expect(claimPatch("s", config, "agent-9").metadata.labels["paseo.sh/agent"]).toBe("agent-9");
  });

  it("an agent in use has no expiry in any state; a draft gets finite ones", () => {
    expect(suspendPatch(true).spec.shutdownTime).toBeNull();
    expect(resumePatch(config, true).spec.shutdownTime).toBeNull();
    expect(usedPatch().spec.shutdownTime).toBeNull();
    expect(Date.parse(suspendPatch(false).spec.shutdownTime as string) - Date.now()).toBeLessThan(2 * 3600 * 1000);
    expect(Date.parse(resumePatch(config, false).spec.shutdownTime as string) - Date.now()).toBeGreaterThan(7 * 3600 * 1000);
  });

  it("the connection labels a new sandbox with the daemon id and the agent id from the session env", async () => {
    const kube = new FakeKube();
    const conn = await connectKube({ versions: [1], capabilities: [] }, { config, kube, acpProvider: new FakeAcp().provider, detectRepo: async () => ({ url: "https://github.com/x/y", branch: "main" }), seeder: fakeSeeder, eager: true, sleep: async () => undefined, now: () => 1, daemonId: "srv_ME" });
    await conn.send({ type: "session.open", requestId: "r", sessionId: "s1", config: { cwd: "/x", env: { PASEO_KUBE_AGENT_ID: "agent-77" }, mcpServers: {}, settings: {}, persist: false }, history: "skip" });
    expect((kube.applied[0] as any).metadata.labels).toMatchObject({ "paseo.sh/daemon": "srv_ME", "paseo.sh/agent": "agent-77" });
  });

  it("reads the daemon id from Paseo's home", () => {
    const home = mkdtempSync(join(tmpdir(), "kube-home-"));
    expect(readDaemonId(home)).toBeUndefined();
    writeFileSync(join(home, "server-id"), "srv_ABC123\n");
    expect(readDaemonId(home)).toBe("srv_ABC123");
    writeFileSync(join(home, "server-id"), "not a valid label value!!");
    expect(readDaemonId(home)).toBeUndefined();
  });
});

describe("asking Paseo about an agent", () => {
  const ok = (body: object) => async () => ({ stdout: JSON.stringify(body) });
  const fail = (streams: { stdout?: string; stderr?: string }) => async () => {
    throw Object.assign(new Error("exit 1"), streams);
  };
  const notFound = JSON.stringify({ error: { code: "AGENT_NOT_FOUND", message: "Agent not found: x" } });

  it("alive when found and not archived, gone when archived", async () => {
    expect(await paseoAgentState("a", ok({ Id: "a", Archived: false }))).toBe("alive");
    expect(await paseoAgentState("a", ok({ Id: "a", Archived: true }))).toBe("gone");
  });

  it("gone when Paseo says AGENT_NOT_FOUND, on stderr (what the CLI really does) or stdout", async () => {
    expect(await paseoAgentState("a", fail({ stderr: notFound }))).toBe("gone");
    expect(await paseoAgentState("a", fail({ stdout: notFound }))).toBe("gone");
    expect(await paseoAgentState("a", ok(JSON.parse(notFound)))).toBe("gone");
  });

  it("unknown, never gone, for anything else: daemon unreachable, a crash, garbage, a missing binary", async () => {
    const unreachable = JSON.stringify({ error: { code: "DAEMON_UNREACHABLE" } });
    expect(await paseoAgentState("a", fail({ stderr: unreachable }))).toBe("unknown");
    expect(await paseoAgentState("a", fail({ stderr: "boom" }))).toBe("unknown");
    expect(await paseoAgentState("a", async () => ({ stdout: "not json" }))).toBe("unknown");
    expect(await paseoAgentState("a", async () => { throw new Error("spawn paseo ENOENT"); })).toBe("unknown");
  });
});
