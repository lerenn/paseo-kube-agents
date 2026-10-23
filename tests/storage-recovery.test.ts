import { describe, expect, it } from "vitest";
import type { ProviderEvent, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { ConfigSchema } from "../shared/settings.js";
import { connectKube } from "../server/connection.js";
import { parsePodInfo } from "../server/kube.js";
import { waitPodReady } from "../server/pod-wait.js";
import { buildSandbox, workspaceClaimName } from "../server/sandbox.js";
import { FakeAcp, FakeKube, fakeSeeder } from "./fakes.js";

const manifest = (storage?: object) => {
  const config = ConfigSchema.parse(storage ? { storage } : {});
  return buildSandbox({ name: "n", sessionId: "s", config }) as any;
};

describe("workspace storage manifest", () => {
  it("defaults to a 10Gi ReadWriteOnce claim on the cluster's default StorageClass", () => {
    const sb = manifest();
    expect(sb.spec.volumeClaimTemplates).toEqual([
      { metadata: { name: "workspace" }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "10Gi" } } } },
    ]);
    expect(sb.spec.podTemplate.spec.volumes).toBeUndefined(); // the controller adds the claim volume
    expect(sb.spec.podTemplate.spec.containers[0].volumeMounts).toEqual([{ name: "workspace", mountPath: "/workspace" }]);
    expect(JSON.stringify(sb)).not.toMatch(/storageClassName/);
    expect(workspaceClaimName("n")).toBe("workspace-n");
  });

  it("uses a given size and StorageClass, with no cloud-specific fields", () => {
    const sb = manifest({ size: "50Gi", storageClassName: "fast" });
    expect(sb.spec.volumeClaimTemplates[0].spec).toMatchObject({ resources: { requests: { storage: "50Gi" } }, storageClassName: "fast" });
    expect(JSON.stringify(sb)).not.toMatch(/aws|gce|azure|ebs|csi/i);
  });

  it("ephemeral mode is an emptyDir with no claim", () => {
    const sb = manifest({ mode: "ephemeral" });
    expect(sb.spec.volumeClaimTemplates).toBeUndefined();
    expect(sb.spec.podTemplate.spec.volumes).toEqual([{ name: "workspace", emptyDir: {} }]);
  });

  it("keeps HOME on the volume so the agent's session state survives a pod restart", () => {
    const c = manifest().spec.podTemplate.spec.containers[0];
    expect(c.env).toEqual([{ name: "HOME", value: "/workspace/.home" }]);
    expect(c.command.join(" ")).toContain("mkdir -p");
  });

  it("rejects malformed sizes", () => {
    expect(() => ConfigSchema.parse({ storage: { size: "ten gigs" } })).toThrow();
    expect(() => ConfigSchema.parse({ storage: { mode: "nfs" } })).toThrow();
  });
});

describe("pod status", () => {
  it("explains an unschedulable pod, e.g. a volume bound to another zone", () => {
    const info = parsePodInfo({
      metadata: { uid: "u" },
      status: { conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes: volume node affinity conflict" }] },
    });
    expect(info.ready).toBe(false);
    expect(info.problem).toContain("volume node affinity conflict");
  });

  it("reports readiness, termination and image problems", () => {
    expect(parsePodInfo({ metadata: { uid: "u" }, status: { conditions: [{ type: "Ready", status: "True" }] } }).ready).toBe(true);
    expect(parsePodInfo({ metadata: { uid: "u", deletionTimestamp: "t" }, status: {} }).terminating).toBe(true);
    const pull = parsePodInfo({ metadata: { uid: "u" }, status: { containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff", message: "denied" } } }] } });
    expect(pull.problem).toContain("ImagePullBackOff");
  });
});

describe("waitPodReady", () => {
  const clock = () => {
    let t = 0;
    return () => (t += 1000);
  };

  it("waits through a missing then pending pod and returns once ready", async () => {
    const kube = new FakeKube();
    kube.pods = [null, { uid: "u1", ready: false, terminating: false, problem: "Pod cannot be scheduled: waiting for a node" }, { uid: "u1", ready: true, terminating: false }];
    const seen: string[] = [];
    const info = await waitPodReady(kube, "p", { timeoutSeconds: 60, sleep: async () => undefined, now: clock(), onProblem: (m) => seen.push(m) });
    expect(info.ready).toBe(true);
    expect(seen).toEqual(["Pod cannot be scheduled: waiting for a node"]);
  });

  it("does not accept a terminating pod that still reports Ready", async () => {
    const kube = new FakeKube();
    kube.pods = [{ uid: "old", ready: true, terminating: true }, { uid: "new", ready: true, terminating: false }];
    const info = await waitPodReady(kube, "p", { timeoutSeconds: 60, sleep: async () => undefined, now: clock() });
    expect(info.uid).toBe("new");
  });

  it("times out with the scheduling problem in the message, not silently", async () => {
    const kube = new FakeKube();
    kube.pods = [{ uid: "u", ready: false, terminating: false, problem: "Pod cannot be scheduled: volume node affinity conflict" }];
    await expect(waitPodReady(kube, "p", { timeoutSeconds: 5, sleep: async () => undefined, now: clock() })).rejects.toThrow(/not ready after 5s: Pod cannot be scheduled: volume node affinity conflict/);
  });
});

describe("pod loss recovery", () => {
  const flush = () => new Promise((r) => setTimeout(r, 5));
  const cfg = (): ProviderSessionConfig => ({ cwd: "/home/me/repo", env: {}, mcpServers: {}, settings: {}, persist: false });
  const repo = async () => ({ url: "https://github.com/lerenn/x", branch: "main" });

  async function opened(storage?: object) {
    const kube = new FakeKube();
    const acp = new FakeAcp();
    const events: ProviderEvent[] = [];
    let t = 0;
    const conn = await connectKube(
      { versions: [1], capabilities: ["prompt.message"] },
      { config: ConfigSchema.parse(storage ? { storage } : {}), kube, acpProvider: acp.provider, detectRepo: repo, seeder: fakeSeeder, sleep: async () => undefined, now: () => (t += 1000) },
    );
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", config: cfg(), history: "skip" });
    return { kube, acp, events, conn };
  }

  it("resumes the agent session on the replacement pod without re-cloning or telling Paseo it died", async () => {
    const { kube, acp, events } = await opened();
    const clones = () => kube.execs.filter((e) => e.argv[0] === "sh").length;
    expect(clones()).toBe(1);
    const before = events.length;
    kube.pods = [{ uid: "old", ready: true, terminating: true }, { uid: "new", ready: true, terminating: false }];
    acp.emit({ type: "session.runtime_failed", sessionId: "s1", error: { message: "ACP transport closed unexpectedly" } });
    await flush();

    expect(clones()).toBe(1); // the volume still has the clone
    expect(acp.inputs.filter((i) => i.type === "session.open")).toHaveLength(2);
    const reopen = acp.inputs.filter((i) => i.type === "session.open")[1] as any;
    expect(reopen.requestId).toMatch(/^recover-/);
    expect(reopen.persistence).toEqual({ version: 1, data: { sessionId: "native-s1" } });
    expect(reopen.history).toBe("skip");
    const after = events.slice(before);
    expect(after.some((e) => e.type === "session.runtime_failed")).toBe(false);
    expect(after.filter((e) => e.type === "session.opened")).toHaveLength(0);
    const titles = after.filter((e) => e.type === "session.notice").map((e: any) => e.notice.title);
    expect(titles[0]).toBe("Pod lost, waiting for a replacement");
    expect(titles.at(-1)).toBe("Reconnected on a new pod");
  });

  it("fails the turn that was running when the pod was lost", async () => {
    const { acp, events, kube } = await opened();
    acp.emit({ type: "session.turn", sessionId: "s1", turnId: "t9", state: "started" });
    kube.pods = [{ uid: "new", ready: true, terminating: false }];
    acp.emit({ type: "session.runtime_failed", sessionId: "s1", error: { message: "x" } });
    await flush();
    expect(events.some((e) => e.type === "session.turn" && e.turnId === "t9" && e.state === "failed")).toBe(true);
  });

  it("re-clones when the volume was ephemeral and is empty on the new pod", async () => {
    const { kube, acp } = await opened({ mode: "ephemeral" });
    kube.hasClone = false; // new emptyDir
    acp.emit({ type: "session.runtime_failed", sessionId: "s1", error: { message: "x" } });
    await flush();
    expect(kube.execs.filter((e) => e.argv[0] === "sh")).toHaveLength(2);
  });

  it("shows why a replacement pod cannot start, then reports the failure to Paseo", async () => {
    const { kube, acp, events } = await opened();
    kube.pods = [{ uid: "u", ready: false, terminating: false, problem: "Pod cannot be scheduled: volume node affinity conflict" }];
    acp.emit({ type: "session.runtime_failed", sessionId: "s1", error: { message: "x" } });
    await flush();
    const notices = events.filter((e) => e.type === "session.notice").map((e: any) => e.notice.title);
    expect(notices).toContain("Pod cannot be scheduled: volume node affinity conflict");
    const failed = events.find((e) => e.type === "session.runtime_failed") as any;
    expect(failed.error.message).toMatch(/could not recover.*volume node affinity conflict/);
  });

  it("stops after repeated failures instead of looping", async () => {
    const { acp, events } = await opened();
    for (let i = 0; i < 4; i++) {
      acp.emit({ type: "session.runtime_failed", sessionId: "s1", error: { message: "x" } });
      await flush();
    }
    const failed = events.filter((e) => e.type === "session.runtime_failed") as any[];
    expect(failed).toHaveLength(1);
    expect(failed[0].error.message).toMatch(/keeps failing/);
  });

  it("does not recover a session Paseo is closing, and deletes the sandbox and claim", async () => {
    const { kube, acp, conn } = await opened();
    await conn.send({ type: "session.close", requestId: "c", sessionId: "s1" });
    const opensBefore = acp.inputs.filter((i) => i.type === "session.open").length;
    acp.emit({ type: "session.runtime_failed", sessionId: "s1", error: { message: "x" } });
    await flush();
    expect(acp.inputs.filter((i) => i.type === "session.open")).toHaveLength(opensBefore);
    const deletes = kube.calls.filter((c) => c.startsWith("delete:"));
    expect(deletes[0]).toMatch(/^delete:sandbox\//);
    expect(deletes[1]).toMatch(/^delete:pvc\/workspace-/);
  });
});
