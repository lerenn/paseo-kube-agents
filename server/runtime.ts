import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { parseRuntimeOptions, type RuntimeOptions } from "../shared/runtime-options.js";
import { applyPush, loopbackPorts, startBridge, type RunningBridge } from "./bridge.js";
import type { KubernetesRuntimeConfig } from "./config.js";
import { type GitRunner, runGit } from "./git.js";
import type { Kube, SandboxInfo } from "./kube.js";
import { LAUNCH_SCRIPT } from "./pod-assets.js";
import { ensureCommand, installAssets, seedWorkspace, writeEnvFile } from "./pod-setup.js";
import { waitPodReady } from "./pod-wait.js";
import { PodRegistry, type PodState } from "./registry.js";
import type {
  WorkspaceRuntimeActivityEvent,
  WorkspaceRuntimeContext,
  WorkspaceRuntimeExecRequest,
  WorkspaceRuntimeInputRequest,
  WorkspaceRuntimePrepareRequest,
  WorkspaceRuntimeProcess,
  WorkspaceRuntimeRegistration,
  WorkspaceRuntimeStatus,
  WorkspaceRuntimeWorkspaceRequest,
} from "./runtime-types.js";
import {
  CWD_ANNOTATION,
  DAEMON_LABEL,
  WORKSPACE_LABEL,
  buildSandbox,
  resumePatch,
  sandboxName,
  suspendPatch,
  workspaceClaimName,
} from "./sandbox.js";
import { createSeed, releaseSeed, seedBundle, type Seed } from "./seed.js";
import { clonePlan, detectRepo, repoName, type ClonePlan, type RepoRef } from "./workspace.js";

export interface SeedBundle {
  seed: Seed;
  bundle: Readable;
  /** Resolves when the bundle has been fully produced. */
  done: Promise<void>;
  release(): Promise<void>;
}

export interface RuntimeDeps {
  getConfig(): Promise<KubernetesRuntimeConfig>;
  kubeFor(config: KubernetesRuntimeConfig): Kube;
  /** This daemon's id, written on every sandbox and volume claim so the reaper only ever considers its own. */
  daemonId?: string;
  /** Where workspace states are published for the Kubernetes Runtime screen. */
  registry?: PodRegistry;
  /** Git on the daemon, with the daemon's own credentials (injected for tests). */
  git?: GitRunner;
  /** Builds the seed bundle from the daemon's checkout (injected for tests). */
  seeder?: (cwd: string, plan: ClonePlan | null, currentBranch: string) => Promise<SeedBundle>;
  detectRepo?: (cwd: string) => Promise<RepoRef>;
  /** Pod port to daemon port for loopback tunnels (identity in production; tests share one host). */
  mapTunnelPort?: (port: number) => number;
  /** Calls `fn` every `ms` until the returned stop function runs (injected for tests). */
  ticker?: (fn: () => void, ms: number) => () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

interface AgentActivity {
  turn: boolean;
  pendingPermissions: number;
}

interface WorkspaceState {
  id: string;
  options: RuntimeOptions;
  sandbox?: string;
  phase: PodState | "none";
  bridge?: RunningBridge;
  ports: Set<number>;
  /** The pod the pod-side setup was last verified for; a replacement pod has another uid and is set up again. */
  readyUid?: string;
  commands: Set<string>;
  agents: Map<string, AgentActivity>;
  lastActivity: number;
  /** Everything that changes the pod (create, resume, suspend, destroy, prepare) runs one at a time. */
  chain: Promise<unknown>;
}

export const RUNTIME_LABEL = "Kubernetes Runtime";

/**
 * A workspace runtime that runs a workspace's provider processes (real claude, codex, ...) in a pod of its
 * own. The pod is created when the first process is about to start, seeded from a git bundle of the daemon's
 * checkout, which the pod shows at the daemon's own absolute path; it is suspended when every agent has been
 * idle for a while, resumed by the next input, and deleted when the workspace is archived.
 */
export class KubernetesRuntime {
  private readonly states = new Map<string, WorkspaceState>();
  private stopTicker: () => void = () => undefined;
  private readonly git: GitRunner;
  private readonly now: () => number;

  constructor(private readonly deps: RuntimeDeps) {
    this.git = deps.git ?? runGit;
    this.now = deps.now ?? Date.now;
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  /** Starts the idle timer and picks up the pods a previous plugin run left running. */
  async start(): Promise<void> {
    const tick = () => void this.checkIdle().catch(() => undefined);
    this.stopTicker = (this.deps.ticker ?? ((fn, ms) => {
      const timer = setInterval(fn, ms) as unknown as NodeJS.Timeout;
      timer.unref?.();
      return () => clearInterval(timer);
    }))(tick, 30_000);
    await this.adopt().catch(() => undefined);
  }

  stop(): void {
    this.stopTicker();
    for (const ws of this.states.values()) ws.bridge?.close();
  }

  /** Re-reads the cluster: the workspaces this daemon has sandboxes for, so idle ones are suspended after a restart. */
  private async adopt(): Promise<void> {
    if (!this.deps.daemonId) return;
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    for (const sandbox of await kube.listSandboxes(`${DAEMON_LABEL}=${this.deps.daemonId}`)) {
      const id = sandbox.labels[WORKSPACE_LABEL];
      const cwd = sandbox.annotations[CWD_ANNOTATION];
      if (!id || !cwd || this.states.has(id)) continue;
      const ws = this.newState(id, { cwd });
      ws.sandbox = sandbox.name;
      this.setPhase(ws, sandbox.operatingMode === "Suspended" ? "suspended" : "running");
    }
  }

  private newState(id: string, options: RuntimeOptions): WorkspaceState {
    const ws: WorkspaceState = {
      id,
      options,
      phase: "none",
      ports: new Set(),
      commands: new Set(),
      agents: new Map(),
      lastActivity: this.now(),
      chain: Promise.resolve(),
    };
    this.states.set(id, ws);
    return ws;
  }

  private workspace(request: WorkspaceRuntimeWorkspaceRequest): WorkspaceState {
    const options = parseRuntimeOptions(request.options);
    const ws = this.states.get(request.workspaceId) ?? this.newState(request.workspaceId, options);
    ws.options = options;
    return ws;
  }

  private setPhase(ws: WorkspaceState, phase: PodState): void {
    ws.phase = phase;
    if (ws.sandbox) this.deps.registry?.set(ws.id, ws.sandbox, phase, this.now());
  }

  private serial<T>(ws: WorkspaceState, fn: () => Promise<T>): Promise<T> {
    const run = ws.chain.then(fn);
    ws.chain = run.catch(() => undefined);
    return run;
  }

  private identity = async (cwd: string) => {
    const read = async (key: string, fallback: string) => {
      const r = await this.git(["config", key], { cwd }).catch(() => null);
      return r && r.code === 0 && r.stdout.trim() ? r.stdout.trim() : fallback;
    };
    return { name: await read("user.name", "Paseo Agent"), email: await read("user.email", "agent@paseo.invalid") };
  };

  private async seedIfEmpty(kube: Kube, ws: WorkspaceState, pod: string, ctx: WorkspaceRuntimeContext): Promise<void> {
    const { cwd } = ws.options;
    const present = await kube.exec(pod, ["test", "-d", `${cwd}/.git`]);
    if (present.code === 0) return;
    ctx.notice("Copying the project into the pod...");
    const repo = await (this.deps.detectRepo ?? detectRepo)(cwd);
    const plan = clonePlan(ws.options);
    const made = await (this.deps.seeder ?? this.defaultSeeder)(cwd, plan, repo.branch);
    try {
      await seedWorkspace(kube, pod, made.seed, made.bundle, {
        dir: cwd,
        originUrl: repo.url,
        identity: await this.identity(cwd),
        newBranch: plan?.action === "branch-off" && plan.slug ? plan.slug : undefined,
      });
      await made.done;
    } finally {
      await made.release().catch(() => undefined);
    }
  }

  private defaultSeeder = async (cwd: string, plan: ClonePlan | null, currentBranch: string): Promise<SeedBundle> => {
    const seed = await createSeed(this.git, cwd, plan, currentBranch);
    const { stream, done } = seedBundle(cwd, seed);
    return { seed, bundle: stream, done, release: () => releaseSeed(this.git, cwd, seed) };
  };

  private startBridge(kube: Kube, ws: WorkspaceState, ports: Set<number>): void {
    ws.bridge?.close();
    ws.ports = ports;
    ws.bridge = startBridge(
      kube,
      ws.sandbox!,
      [...ports],
      { handle: (request) => applyPush(this.git, ws.options.cwd, request) },
      { mapPort: this.deps.mapTunnelPort },
    );
  }

  /** Brings the workspace's pod to a state where a provider process can start; cheap once it already is. */
  private async ensureReady(
    ws: WorkspaceState,
    ctx: WorkspaceRuntimeContext,
    need: { command?: string; mcpServers?: Record<string, unknown>; env?: Record<string, string> } = {},
  ): Promise<void> {
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    const { cwd } = ws.options;
    const wanted = new Set([...ws.ports, ...loopbackPorts((need.mcpServers ?? {}) as Record<string, { type: string; url?: string }>, [need.env?.PASEO_GITHUB_PROXY_URL])]);
    const grows = [...wanted].some((p) => !ws.ports.has(p));

    // Fast path: the same pod is up and everything this launch needs is already in place.
    if (ws.sandbox && ws.phase === "running" && ws.readyUid && !grows && (!need.command || ws.commands.has(need.command))) {
      const info = await kube.podInfo(ws.sandbox).catch(() => null);
      if (info?.ready && !info.terminating && info.uid === ws.readyUid) return;
    }

    let sandbox: SandboxInfo | undefined;
    if (ws.sandbox) sandbox = (await kube.listSandboxes(`${WORKSPACE_LABEL}=${ws.id}`)).find((s) => s.name === ws.sandbox);
    sandbox ??= (await kube.listSandboxes(`${WORKSPACE_LABEL}=${ws.id}`))[0];

    if (!sandbox) {
      ctx.notice("Starting the pod...");
      const repo = await (this.deps.detectRepo ?? detectRepo)(cwd);
      const name = sandboxName(ws.id, repoName(repo.url), ws.options.slug);
      await kube.apply(buildSandbox({ name, workspaceId: ws.id, cwd, config, daemonId: this.deps.daemonId }));
      ws.sandbox = name;
    } else {
      ws.sandbox = sandbox.name;
      if (sandbox.operatingMode === "Suspended") {
        ctx.notice("Resuming the pod...");
        this.setPhase(ws, "resuming");
        await kube.patchSandbox(sandbox.name, resumePatch(config, cwd));
      }
    }
    this.setPhase(ws, "resuming");

    try {
      const pod = ws.sandbox;
      const info = await waitPodReady(kube, pod, {
        timeoutSeconds: config.readyTimeoutSeconds,
        sleep: this.deps.sleep,
        now: this.deps.now,
        onProblem: (problem) => ctx.notice(problem, "warning"),
      });
      await installAssets(kube, pod);
      await this.seedIfEmpty(kube, ws, pod, ctx);
      if (need.command && !ws.commands.has(need.command)) {
        ctx.notice(`Checking ${need.command} in the pod...`);
        await ensureCommand(kube, pod, need.command);
        ws.commands.add(need.command);
      }
      if (!ws.bridge || grows || ws.readyUid !== info.uid) this.startBridge(kube, ws, wanted);
      ws.readyUid = info.uid;
      this.setPhase(ws, "running");
      ws.lastActivity = this.now();
    } catch (error) {
      ws.readyUid = undefined;
      // Left suspended-looking so the next input retries from a clean state; the volume and the sandbox stay.
      await kube.patchSandbox(ws.sandbox, suspendPatch()).catch(() => undefined);
      ws.bridge?.close();
      ws.bridge = undefined;
      ws.commands.clear();
      this.setPhase(ws, "suspended");
      const message = (error as Error).message;
      ctx.notice(`Could not start the pod: ${message}`, "error");
      throw new Error(`kube: could not start the pod: ${message}`);
    }
  }

  private async suspend(ws: WorkspaceState): Promise<void> {
    if (!ws.sandbox || ws.phase !== "running") return;
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    this.log(`[kubernetes-runtime] suspending idle pod ${ws.sandbox} (workspace ${ws.id})`);
    ws.bridge?.close();
    ws.bridge = undefined;
    ws.readyUid = undefined;
    ws.commands.clear();
    this.setPhase(ws, "suspended"); // before the pod goes: processes that end with it are reported as runtime-lost
    await kube.patchSandbox(ws.sandbox, suspendPatch());
  }

  /** Suspends every workspace whose agents have all been idle for `podIdleMinutes`. */
  async checkIdle(): Promise<void> {
    const config = await this.deps.getConfig();
    const limit = config.podIdleMinutes * 60_000;
    if (limit <= 0 || config.storage.mode !== "persistent") return;
    for (const ws of this.states.values()) {
      const busy = [...ws.agents.values()].some((a) => a.turn || a.pendingPermissions > 0);
      if (ws.phase === "running" && !busy && this.now() - ws.lastActivity >= limit) {
        await this.serial(ws, () => this.suspend(ws)).catch(() => undefined);
      }
    }
  }

  /** The registration Paseo's fork takes. */
  registration(): WorkspaceRuntimeRegistration {
    return {
      id: "kubernetes",
      label: RUNTIME_LABEL,
      describe: () => ({ protocolVersion: 1, capabilities: { pipes: true, pty: false } }),
      create: async (request) => {
        this.workspace(request); // validates the options; nothing exists in the cluster until a process is about to start
      },
      inspect: (request) => this.inspect(request),
      destroy: (request) => this.destroy(request),
      reconcile: () => this.reconcile(),
      prepare: (request, ctx) => this.prepare(request, ctx),
      beforeInput: (request, ctx) => this.beforeInput(request, ctx),
      onActivity: (event) => this.onActivity(event),
      exec: (request, ctx) => this.exec(request, ctx),
    };
  }

  async prepare(request: WorkspaceRuntimePrepareRequest, ctx: WorkspaceRuntimeContext): Promise<void> {
    const ws = this.workspace(request);
    await this.serial(ws, () => this.ensureReady(ws, ctx, { command: request.argv[0], mcpServers: request.mcpServers, env: request.env }));
  }

  async beforeInput(request: WorkspaceRuntimeInputRequest, ctx: WorkspaceRuntimeContext): Promise<void> {
    const ws = this.workspace(request);
    ws.lastActivity = this.now();
    await this.serial(ws, async () => {
      if (ws.phase === "suspended" || ws.phase === "resuming") await this.ensureReady(ws, ctx, {});
    });
  }

  onActivity(event: WorkspaceRuntimeActivityEvent): void {
    const ws = this.states.get(event.workspaceId);
    if (!ws) return;
    const agent = ws.agents.get(event.agentId) ?? { turn: false, pendingPermissions: 0 };
    if (event.activity === "turn_started") agent.turn = true;
    if (event.activity === "turn_ended") agent.turn = false;
    if (event.activity === "permission_requested") agent.pendingPermissions++;
    if (event.activity === "permission_resolved") agent.pendingPermissions = Math.max(0, agent.pendingPermissions - 1);
    ws.agents.set(event.agentId, agent);
    ws.lastActivity = this.now();
  }

  async inspect(request: WorkspaceRuntimeWorkspaceRequest): Promise<WorkspaceRuntimeStatus> {
    const ws = this.workspace(request);
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    const sandbox = (await kube.listSandboxes(`${WORKSPACE_LABEL}=${ws.id}`))[0];
    if (!sandbox) return { state: "absent" };
    if (sandbox.operatingMode === "Suspended") return { state: "suspended" };
    const pod = await kube.podInfo(sandbox.name).catch(() => null);
    if (pod?.ready && !pod.terminating) return { state: "running" };
    return { state: "resuming", ...(pod?.problem ? { message: pod.problem } : {}) };
  }

  /** The workspace was archived: its pod and volume go. */
  async destroy(request: WorkspaceRuntimeWorkspaceRequest): Promise<void> {
    const ws = this.workspace(request);
    await this.serial(ws, async () => {
      const config = await this.deps.getConfig();
      const kube = this.deps.kubeFor(config);
      ws.bridge?.close();
      for (const sandbox of await kube.listSandboxes(`${WORKSPACE_LABEL}=${ws.id}`)) {
        await kube.delete("sandbox", sandbox.name);
        await kube.delete("pvc", workspaceClaimName(sandbox.name)).catch(() => undefined);
      }
      this.deps.registry?.delete(ws.id);
      this.states.delete(ws.id);
    });
  }

  /** After a pod was lost: forget what was set up in it, so the next launch sets up the replacement. */
  async reconcile(): Promise<void> {
    for (const ws of this.states.values()) {
      ws.bridge?.close();
      ws.bridge = undefined;
      ws.readyUid = undefined;
      ws.commands.clear();
    }
    await this.adopt().catch(() => undefined);
  }

  async exec(request: WorkspaceRuntimeExecRequest, ctx: WorkspaceRuntimeContext & { signal: AbortSignal }): Promise<WorkspaceRuntimeProcess> {
    const ws = this.workspace(request);
    if (request.purpose === "probe") throw new Error("Probes run on the daemon host; the Kubernetes Runtime does not start them");
    await this.serial(ws, () => this.ensureReady(ws, ctx, { command: request.argv[0], env: request.env }));
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    const pod = ws.sandbox!;
    const envPath = await writeEnvFile(kube, pod, randomBytes(6).toString("hex"), request.env);
    const cwd = request.cwd ?? ws.options.cwd;
    const proc = kube.spawnExec(pod, ["sh", "-c", LAUNCH_SCRIPT, "sh", envPath, cwd, ...request.argv]);
    const abort = () => proc.kill();
    ctx.signal.addEventListener("abort", abort, { once: true });
    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      signal: (signal) => proc.kill(signal),
      exit: proc.exit.then(async ({ code, signal }) => {
        ctx.signal.removeEventListener("abort", abort);
        // An exec that ends because the pod went away is the runtime's doing, not the process finishing.
        const info = await kube.podInfo(pod).catch(() => null);
        const lost = ws.phase === "suspended" || !info || !info.ready || info.terminating;
        if (lost && code !== 0) {
          return { code, signal, reason: "runtime-lost" as const, message: "The pod was suspended or lost; the next message brings it back" };
        }
        return { code, signal, reason: "exited" as const };
      }),
    };
  }
}
