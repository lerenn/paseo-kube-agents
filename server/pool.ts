import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KubeAgentsConfig } from "./config.js";
import type { Kube, SandboxInfo } from "./kube.js";
import { POOL_LABEL, SPEC_HASH_ANNOTATION, buildSandbox, claimPatch, specHash, workspaceClaimName } from "./sandbox.js";

export interface PoolStatus {
  state: "off" | "active" | "asleep";
  size: number;
  /** Warm pods ready to be claimed. */
  ready: number;
  /** Warm pods still starting. */
  starting: number;
  /** When the pool went to sleep (ISO), if it is asleep. */
  asleepSince?: string;
}

interface PoolState {
  lastRequestAt: number;
  asleepSince?: number;
}

export interface PoolDeps {
  getConfig(): Promise<KubeAgentsConfig>;
  kubeFor(config: KubeAgentsConfig): Kube;
  now?: () => number;
  statePath?: string;
  /** Name for a new warm sandbox (injected for tests). */
  newName?: () => string;
}

export function defaultPoolStatePath(): string {
  return join(homedir(), ".paseo", "kube-agents-pool.json");
}

/**
 * A small pool of pre-started Sandboxes, so a new agent does not wait for a node and a volume. It is
 * managed here rather than by agent-sandbox's warm pool CRDs, which are not installed. Warm pods are only
 * ever used for new agents: a resumed agent needs its own volume, which is bound to its own zone.
 */
export class WarmPool {
  private readonly now: () => number;
  private readonly statePath: string;
  private state: PoolState;
  private chain: Promise<unknown> = Promise.resolve();
  /** True while warm pods may exist, so a disabled pool costs no cluster calls once it has been cleaned up. */
  private mayHaveWarm = true;
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: PoolDeps) {
    this.now = deps.now ?? Date.now;
    this.statePath = deps.statePath ?? defaultPoolStatePath();
    this.state = this.load();
  }

  private load(): PoolState {
    try {
      const stored = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<PoolState>;
      return { lastRequestAt: stored.lastRequestAt ?? this.now(), ...(stored.asleepSince ? { asleepSince: stored.asleepSince } : {}) };
    } catch {
      return { lastRequestAt: this.now() };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(this.state), { mode: 0o600 });
    } catch {
      // the state only keeps the sleep timer across restarts; losing it is harmless
    }
  }

  /** Every new pod agent request counts as activity, and wakes a sleeping pool (that request itself stays cold). */
  noteRequest(): void {
    this.state = { lastRequestAt: this.now() };
    this.save();
    void this.kick();
  }

  /** Reserves a ready warm pod for `sessionId`, or returns null (disabled, asleep, none ready or all stale). */
  async claim(sessionId: string): Promise<string | null> {
    const config = await this.deps.getConfig();
    if (!config.warmPool.enabled || this.state.asleepSince) return null;
    const kube = this.deps.kubeFor(config);
    const hash = specHash(config);
    const warm = (await kube.listSandboxes(`${POOL_LABEL}=warm`)).filter((s) => s.annotations[SPEC_HASH_ANNOTATION] === hash);
    for (const sandbox of warm) {
      const pod = await kube.podInfo(sandbox.name).catch(() => null);
      if (!pod?.ready || pod.terminating) continue;
      await kube.patchSandbox(sandbox.name, claimPatch(sessionId, config));
      void this.kick();
      return sandbox.name;
    }
    return null;
  }

  /** Reconciles now, after whatever is already running. */
  kick(): Promise<void> {
    const next = this.chain.then(() => this.reconcile()).catch(() => undefined);
    this.chain = next;
    return next as Promise<void>;
  }

  start(intervalMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => void this.kick(), intervalMs) as unknown as NodeJS.Timeout;
    this.timer.unref?.();
    void this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async deleteSandbox(kube: Kube, name: string): Promise<void> {
    await kube.delete("sandbox", name);
    await kube.delete("pvc", workspaceClaimName(name)).catch(() => undefined);
  }

  /** Brings the pool to the wanted size: recycles pods built for old settings, creates missing ones, trims extras. */
  async reconcile(): Promise<void> {
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    const { enabled, size, idleMinutes } = config.warmPool;
    if (!enabled && !this.mayHaveWarm && !this.state.asleepSince) return;
    if (enabled && !this.state.asleepSince && this.now() - this.state.lastRequestAt >= idleMinutes * 60_000) {
      this.state = { ...this.state, asleepSince: this.now() };
      this.save();
    }
    if (!enabled && this.state.asleepSince) {
      this.state = { lastRequestAt: this.now() };
      this.save();
    }
    const wanted = enabled && !this.state.asleepSince ? size : 0;
    this.mayHaveWarm = enabled;

    const hash = specHash(config);
    const warm = await kube.listSandboxes(`${POOL_LABEL}=warm`);
    const stale = warm.filter((s) => s.annotations[SPEC_HASH_ANNOTATION] !== hash);
    const fresh = warm.filter((s) => s.annotations[SPEC_HASH_ANNOTATION] === hash);
    const surplus = fresh.slice(wanted); // keeps the first `wanted`, in list order
    for (const sandbox of [...stale, ...surplus]) await this.deleteSandbox(kube, sandbox.name);
    for (let i = fresh.length; i < wanted; i++) {
      const name = (this.deps.newName ?? (() => `pka-warm-${randomBytes(3).toString("hex")}`))();
      await kube.apply(buildSandbox({ name, sessionId: "", config, pool: true }));
    }
  }

  async status(): Promise<PoolStatus> {
    const config = await this.deps.getConfig();
    const { enabled, size } = config.warmPool;
    if (!enabled) return { state: "off", size, ready: 0, starting: 0 };
    const kube = this.deps.kubeFor(config);
    const warm: SandboxInfo[] = await kube.listSandboxes(`${POOL_LABEL}=warm`).catch(() => []);
    let ready = 0;
    for (const sandbox of warm) {
      const pod = await kube.podInfo(sandbox.name).catch(() => null);
      if (pod?.ready && !pod.terminating) ready++;
    }
    return {
      state: this.state.asleepSince ? "asleep" : "active",
      size,
      ready,
      starting: warm.length - ready,
      ...(this.state.asleepSince ? { asleepSince: new Date(this.state.asleepSince).toISOString() } : {}),
    };
  }
}
