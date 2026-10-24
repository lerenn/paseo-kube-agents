import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WarmPool } from "../server/pool.js";
import { SPEC_HASH_ANNOTATION, specHash } from "../server/sandbox.js";
import { ConfigSchema } from "../shared/settings.js";
import { FakeKube } from "./fakes.js";

const MIN = 60_000;

function setup(warmPool: object = { enabled: true, size: 2, idleMinutes: 60 }, extra: object = {}) {
  const kube = new FakeKube();
  let config = ConfigSchema.parse({ warmPool, ...extra });
  let t = 1_000_000;
  let n = 0;
  const pool = new WarmPool({
    getConfig: async () => config,
    kubeFor: () => kube,
    now: () => t,
    statePath: join(mkdtempSync(join(tmpdir(), "kube-pool-")), "pool.json"),
    newName: () => `pka-warm-${++n}`,
  });
  return {
    kube, pool,
    setConfig: (c: object) => (config = ConfigSchema.parse(c)),
    advance: (ms: number) => (t += ms),
  };
}

describe("warm pool", () => {
  it("creates the missing pods, once", async () => {
    const { kube, pool } = setup();
    await pool.reconcile();
    expect(kube.applied.map((m: any) => m.metadata.name)).toEqual(["pka-warm-1", "pka-warm-2"]);
    expect((kube.applied[0] as any).metadata.labels["paseo.sh/pool"]).toBe("warm");
    expect((kube.applied[0] as any).metadata.labels["paseo.sh/session"]).toBeUndefined();
    await pool.reconcile();
    expect(kube.applied).toHaveLength(2);
  });

  it("makes no cluster call at all once disabled and cleaned up", async () => {
    const { kube, pool } = setup({ enabled: false, size: 1, idleMinutes: 60 });
    await pool.reconcile(); // the one start-up check for leftovers
    const before = kube.calls.length;
    await pool.reconcile();
    await pool.reconcile();
    expect(kube.calls.length).toBe(before);
    expect(kube.applied).toHaveLength(0);
  });

  it("deletes the whole pool, volumes included, when it is disabled", async () => {
    const { kube, pool, setConfig } = setup();
    await pool.reconcile();
    setConfig({ warmPool: { enabled: false, size: 2, idleMinutes: 60 } });
    await pool.reconcile();
    expect(kube.calls.filter((c) => c.startsWith("delete:sandbox/")).sort()).toEqual(["delete:sandbox/pka-warm-1", "delete:sandbox/pka-warm-2"]);
    expect(kube.calls).toContain("delete:pvc/workspace-pka-warm-1");
    expect(kube.sandboxes).toHaveLength(0);
  });

  it("recycles pods built for old settings (image change) and trims surplus", async () => {
    const { kube, pool, setConfig } = setup();
    await pool.reconcile();
    setConfig({ image: "node:23", warmPool: { enabled: true, size: 1, idleMinutes: 60 } });
    await pool.reconcile();
    expect(kube.calls.filter((c) => c.startsWith("delete:sandbox/"))).toHaveLength(2); // both were stale
    expect(kube.sandboxes).toHaveLength(1);
    expect(kube.sandboxes[0]!.annotations[SPEC_HASH_ANNOTATION]).toBe(specHash(ConfigSchema.parse({ image: "node:23" })));
    expect((kube.applied.at(-1) as any).spec.podTemplate.spec.containers[0].image).toBe("node:23");
  });

  it("hands a ready, current warm pod to a new agent and refills behind it", async () => {
    const { kube, pool } = setup({ enabled: true, size: 1, idleMinutes: 60 });
    await pool.reconcile();
    const name = await pool.claim("session-1");
    expect(name).toBe("pka-warm-1");
    const claim = kube.patches2.find((p) => p.name === name)!.patch;
    expect(claim.metadata.labels["paseo.sh/pool"]).toBe("claimed");
    expect(claim.metadata.annotations["paseo.sh/session-id"]).toBe("session-1");
    await pool.kick();
    expect(kube.sandboxes.filter((s) => s.labels["paseo.sh/pool"] === "warm")).toHaveLength(1); // refilled
    expect(kube.sandboxes.map((s) => s.name)).toContain("pka-warm-2");
  });

  it("does not hand out a pod that is still starting, is stale, or when disabled", async () => {
    const { kube, pool, setConfig } = setup({ enabled: true, size: 1, idleMinutes: 60 });
    await pool.reconcile();
    kube.pods = [{ uid: "u", ready: false, terminating: false }];
    expect(await pool.claim("s")).toBeNull();
    kube.pods = [{ uid: "u", ready: true, terminating: false }];
    setConfig({ image: "other", warmPool: { enabled: true, size: 1, idleMinutes: 60 } });
    expect(await pool.claim("s")).toBeNull();
    setConfig({ warmPool: { enabled: false, size: 1, idleMinutes: 60 } });
    expect(await pool.claim("s")).toBeNull();
  });

  it("goes to sleep after the idle time with no request, and wakes on the next one (which stays cold)", async () => {
    const { kube, pool, advance } = setup({ enabled: true, size: 1, idleMinutes: 60 });
    await pool.reconcile();
    expect((await pool.status()).state).toBe("active");
    advance(30 * MIN);
    await pool.reconcile();
    expect((await pool.status()).state).toBe("active");
    advance(31 * MIN);
    await pool.reconcile();
    const asleep = await pool.status();
    expect(asleep.state).toBe("asleep");
    expect(asleep.asleepSince).toBeDefined();
    expect(kube.sandboxes).toHaveLength(0); // burst nodes can be released
    expect(await pool.claim("s")).toBeNull();

    pool.noteRequest(); // a pod agent is requested: this one is cold, the pool refills behind it
    await pool.kick();
    expect((await pool.status()).state).toBe("active");
    expect(kube.sandboxes).toHaveLength(1);
  });

  it("requests keep it awake", async () => {
    const { pool, advance, kube } = setup({ enabled: true, size: 1, idleMinutes: 60 });
    await pool.reconcile();
    for (let i = 0; i < 4; i++) {
      advance(40 * MIN);
      pool.noteRequest();
      await pool.reconcile();
    }
    expect((await pool.status()).state).toBe("active");
    expect(kube.sandboxes).toHaveLength(1);
  });

  it("reports ready and starting pods", async () => {
    const { kube, pool } = setup({ enabled: true, size: 2, idleMinutes: 60 });
    await pool.reconcile();
    kube.pods = [{ uid: "a", ready: true, terminating: false }, { uid: "b", ready: false, terminating: false }];
    const status = await pool.status();
    expect(status).toMatchObject({ state: "active", size: 2, ready: 1, starting: 1 });
    expect((await setup({ enabled: false, size: 1, idleMinutes: 60 }).pool.status()).state).toBe("off");
  });
});
