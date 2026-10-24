import type {
  ProviderConnection,
  ProviderCatalog,
  ProviderConnectRequest,
  ProviderEvent,
  ProviderInput,
  ProviderPersistence,
  ProviderRegistration,
  ProviderToolPolicy,
} from "@getpaseo/plugin/server/provider";
import type { Readable } from "node:stream";
import type { AcpConnector } from "@getpaseo/plugin/server/acp";
import type { KubeAgentsConfig } from "./config.js";
import type { Kube } from "./kube.js";
import { PodRegistry, type PodState } from "./registry.js";
import { ACP_ANNOTATION, NATIVE_LABEL, SESSION_LABEL, buildSandbox, nativeSessionId, resumePatch, sandboxName, sessionLabel, suspendPatch, usedPatch, workspaceClaimName } from "./sandbox.js";
import { REF_ENV_KEYS } from "../shared/pod-ref.js";
import { createCatalogSource } from "./catalog.js";
import { applyPush, loopbackPorts, startBridge, type RunningBridge } from "./bridge.js";
import { type GitRunner, runGit } from "./git.js";
import { LAUNCH_SCRIPT } from "./pod-assets.js";
import { installAssets, seedWorkspace } from "./pod-setup.js";
import { waitPodReady } from "./pod-wait.js";
import { createSeed, releaseSeed, seedBundle, type Seed } from "./seed.js";
import { detectRepo, parseClonePlan, podWorkdir, repoName, type ClonePlan, type RepoRef } from "./workspace.js";

const PROTOCOL_VERSION = 1;
const defaultCatalog = createCatalogSource();
/**
 * The adapter also reports its mode, model and thinking level as generic settings. Paseo already has
 * pickers for those (from the catalog and `session.configure`), so showing them again duplicates them.
 */
const DUPLICATED_SETTING_IDS = new Set(["mode", "model", "thinking", "thought_level", "effort"]);
// `permission.tool_policy` is advertised because Paseo requires it whenever a plugin sets a tool policy
// on a session. The ACP runtime inside cannot take the policy, so it is not forwarded; instead,
// permission requests for preapproved MCP tools are answered here (see `isPreapproved`).
const SUPPORTED_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "session.configure",
  "permission",
  "permission.tool_policy",
  "prompt.image",
  // Paseo reopens a closed agent (after a plugin restart, or once suspended) from its saved handle; without
  // this capability it refuses to resume the session at all.
  "session.persistence",
];

export interface ConnectionDeps {
  config: KubeAgentsConfig;
  kube: Kube;
  /** Builds the ACP-speaking provider that drives one agent process (injected for tests). */
  acpProvider: (connector: AcpConnector) => ProviderRegistration;
  /** Resolves the repo to clone for a daemon-local cwd (injected for tests). */
  detectRepo?: (cwd: string) => Promise<RepoRef>;
  /** Pod port to daemon port for loopback tunnels (identity in production; tests share one host). */
  mapTunnelPort?: (port: number) => number;
  /** The provider catalog (models, thinking levels, modes); defaults to claude's, read from the daemon. */
  catalog?: () => Promise<ProviderCatalog>;
  /** Git on the daemon, with the daemon's own credentials (injected for tests). */
  git?: GitRunner;
  /** Builds the seed bundle from the daemon's checkout (injected for tests). */
  seeder?: (cwd: string, plan: ClonePlan | null, currentBranch: string) => Promise<SeedBundle>;
  /** Pre-started pods for new agents (see WarmPool); absent when pooling is not wired. */
  pool?: { noteRequest(): void; claim(sessionId: string, agentId?: string, handleId?: string): Promise<string | null> };
  /** This daemon's id, written on every sandbox and volume claim so the reaper only ever considers its own. */
  daemonId?: string;
  /** Where session states are published for the Kube Agents screen. */
  registry?: PodRegistry;
  /**
   * Create the pod when the session opens instead of at its first message. Only tests turn this on: in
   * production an opened session costs nothing until it is used, because Paseo opens many sessions that
   * never run (drafts, feature previews, every agent again after a daemon restart).
   */
  eager?: boolean;
  /** Calls `fn` every `ms` until the returned stop function runs (injected for tests). */
  ticker?: (fn: () => void, ms: number) => () => void;
  /** Clock and sleep for pod polling (injected for tests). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SeedBundle {
  seed: Seed;
  bundle: Readable;
  /** Resolves when the bundle has been fully produced. */
  done: Promise<void>;
  release(): Promise<void>;
}

type SessionConfig = Extract<ProviderInput, { type: "session.open" }>["config"];

interface PodSession {
  /** Empty until the pod is first needed. */
  sandbox: string;
  /** True while the session is open but no sandbox exists yet; the first message creates it. */
  deferred: boolean;
  repo: RepoRef;
  plan: ReturnType<typeof parseClonePlan>;
  agentId?: string;
  slug?: string;
  /** The sandbox was created for this session by this plugin: a failed start removes it again. */
  fresh?: boolean;
  localCwd: string;
  podCwd: string;
  /** The session config to reopen on a replacement pod: the daemon-side tool policy is never sent on. */
  config: SessionConfig;
  toolPolicy?: ProviderToolPolicy;
  inner: ProviderConnection;
  bridge?: RunningBridge;
  stopForwarding: () => void;
  /** The agent's own session handle, so a replacement pod can resume the conversation. */
  persistence?: ProviderPersistence;
  /** What Paseo saves to reopen this agent: minted here, stable, never the agent process's own handle. */
  handle: ProviderPersistence;
  /** The agent process's own session handle last written to the sandbox. */
  acpWritten?: string;
  turnId?: string;
  /** Running, suspended (pod deleted, volume kept) or coming back. */
  state: PodState;
  /** True once the agent has been prompted (or has run a turn); drafts that were only opened have not. */
  used: boolean;
  /** Last turn end, input or open; the idle timer counts from here. */
  lastActivity: number;
  /** Permission prompts shown to Paseo and not yet answered: the agent is waiting on a person, not idle. */
  pendingPermissions: number;
  /** The resume in flight, shared so inputs that arrive meanwhile queue behind it. */
  resuming?: Promise<void>;
  /** Tail of the queue of inputs being prepared for delivery (first come, first served). */
  prep: Promise<void>;
  /** False until Paseo's open request has completed; failures before that are not recoverable. */
  opened: boolean;
  recovering: boolean;
  /** True while the agent session is being reopened on a replacement pod. */
  reopening: boolean;
  /** Settles when the agent process has opened (or failed to open) the session being reopened. */
  reopenWaiter?: { requestId: string; settle: (error?: Error) => void };
  closing: boolean;
  /** Timestamps of recent recoveries, to stop a crash loop. */
  recoveries: number[];
}

const MAX_RECOVERIES = 3;
const RECOVERY_WINDOW_MS = 10 * 60 * 1000;

/** Claude names MCP tools `mcp__<server>__<tool>`, with non-alphanumerics in the server name as `_`. */
const mcpToolName = (server: string, tool: string) =>
  `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}__${tool}`;

export function isPreapproved(policy: ProviderToolPolicy | undefined, names: readonly (string | undefined)[]): boolean {
  if (!policy) return false;
  const allowed = new Set(
    policy.preapproved.filter((p) => p.kind === "mcp").map((p) => mcpToolName(p.server, p.tool)),
  );
  return names.some((name) => name !== undefined && allowed.has(name));
}

/** Prefer a one-off allow, then any allow. Undefined when the agent offers no allow option. */
function allowActionId(request: Extract<ProviderEvent, { type: "session.permission" }>["request"]): string | undefined {
  const allows = (request.actions ?? []).filter((a) => a.behavior === "allow");
  return (allows.find((a) => /once/i.test(a.id)) ?? allows[0])?.id;
}

/**
 * One connection serves many Paseo sessions; each session gets its own Sandbox pod. The pod runs
 * an ACP agent over `kubectl exec` stdio and the SDK's ACP runtime turns that into provider events.
 */
export async function connectKube(
  request: ProviderConnectRequest,
  deps: ConnectionDeps,
): Promise<ProviderConnection> {
  if (!request.versions.includes(PROTOCOL_VERSION)) {
    throw new Error(`kube-agents requires provider protocol ${PROTOCOL_VERSION}`);
  }
  const capabilities = SUPPORTED_CAPABILITIES.filter((c) => request.capabilities.includes(c));
  const { config, kube } = deps;
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, PodSession>();
  const opening = new Map<string, Promise<void>>();
  let closed = false;

  const now = () => (deps.now ?? Date.now)();
  const track = (sessionId: string, ps: PodSession, state: PodState, quiet = false) => {
    ps.state = state;
    if (!quiet && ps.sandbox) deps.registry?.set(sessionId, ps.sandbox, state, now());
  };

  const emit = (event: ProviderEvent) => {
    for (const listener of listeners) listener(event);
  };
  const wait = (name: string, onProblem?: (message: string) => void) =>
    waitPodReady(kube, name, {
      timeoutSeconds: config.readyTimeoutSeconds,
      onProblem,
      sleep: deps.sleep,
      now: deps.now,
    });
  const notice = (sessionId: string, severity: "info" | "warning" | "error", title: string) =>
    emit({ type: "session.notice", sessionId, notice: { id: "kube-pod", severity, title } });

  const catalog = deps.catalog ?? defaultCatalog;
  const git: GitRunner = deps.git ?? runGit;
  const seeder =
    deps.seeder ??
    (async (cwd: string, plan: ClonePlan | null, currentBranch: string): Promise<SeedBundle> => {
      const seed = await createSeed(git, cwd, plan, currentBranch);
      const { stream, done } = seedBundle(cwd, seed);
      return { seed, bundle: stream, done, release: () => releaseSeed(git, cwd, seed) };
    });

  async function identity(cwd: string) {
    const read = async (key: string, fallback: string) => {
      const r = await git(["config", key], { cwd }).catch(() => null);
      return r && r.code === 0 && r.stdout.trim() ? r.stdout.trim() : fallback;
    };
    return { name: await read("user.name", "Paseo Agent"), email: await read("user.email", "agent@paseo.invalid") };
  }

  /**
   * Prepares the pod: scripts and shims (always, they are cheap and idempotent), then the workspace
   * built from a bundle of the daemon's checkout, but only when the volume is empty, so a
   * replacement pod keeps the agent's files. Nothing is cloned from GitHub in the pod.
   */
  async function ensureWorkspace(ps: PodSession, repo: RepoRef, plan: ClonePlan | null): Promise<void> {
    await installAssets(kube, ps.sandbox, ps.config.env);
    const present = await kube.exec(ps.sandbox, ["test", "-d", `${ps.podCwd}/.git`]);
    if (present.code === 0) return;
    const made = await seeder(ps.localCwd, plan, repo.branch);
    try {
      await seedWorkspace(kube, ps.sandbox, made.seed, made.bundle, {
        dir: ps.podCwd,
        originUrl: repo.url,
        identity: await identity(ps.localCwd),
        newBranch: plan?.action === "branch-off" && plan.slug ? plan.slug : undefined,
      });
      await made.done;
    } finally {
      await made.release().catch(() => undefined);
    }
  }

  function startPodBridge(ps: PodSession): void {
    ps.bridge?.close();
    // Every loopback URL in the agent's MCP config (and the GitHub proxy's) is tunnelled by port.
    const ports = loopbackPorts(ps.config.mcpServers as Record<string, { type: string; url?: string }>, [ps.config.env.PASEO_GITHUB_PROXY_URL]);
    ps.bridge = startBridge(kube, ps.sandbox, ports, { handle: (request) => applyPush(git, ps.localCwd, request) }, { mapPort: deps.mapTunnelPort });
  }

  /** Starts the agent in the pod and wires its events to Paseo. */
  async function startInner(sessionId: string, ps: PodSession): Promise<ProviderConnection> {
    const connector: AcpConnector = () =>
      kube.execStream(ps.sandbox, ["sh", "-c", LAUNCH_SCRIPT, "sh", ...config.agentCommand]);
    const inner = await deps.acpProvider(connector).connect({
      versions: request.versions,
      capabilities: request.capabilities,
    });
    ps.stopForwarding = inner.onEvent((event) => onInnerEvent(sessionId, ps, inner, event));
    ps.inner = inner;
    return inner;
  }

  /** Keeps the agent process's own handle, on the sandbox too, so a later pod (or plugin) can resume its conversation. */
  function remember(ps: PodSession, persistence: ProviderPersistence): void {
    ps.persistence = persistence;
    const serialized = JSON.stringify(persistence);
    if (!ps.sandbox || ps.acpWritten === serialized) return;
    ps.acpWritten = serialized;
    void kube.patchSandbox(ps.sandbox, { metadata: { annotations: { [ACP_ANNOTATION]: serialized } } }).catch(() => undefined);
  }

  function onInnerEvent(sessionId: string, ps: PodSession, inner: ProviderConnection, event: ProviderEvent) {
    if (inner !== ps.inner) return;
    if (event.type === "session.opened" && event.persistence) remember(ps, event.persistence);
    if (event.type === "session.persistence" && event.sessionId === sessionId) {
      remember(ps, event.persistence);
      return; // Paseo keeps the handle this plugin gave it, not the agent process's
    }
    if (event.type === "session.turn" && event.sessionId === sessionId) {
      ps.turnId = event.state === "started" ? event.turnId : undefined;
      ps.lastActivity = now();
      ps.used = true;
    }
    if (event.type === "session.permission_resolved" && event.sessionId === sessionId) {
      ps.pendingPermissions = Math.max(0, ps.pendingPermissions - 1);
      ps.lastActivity = now();
    }
    if (event.type === "session.config" && event.sessionId === sessionId) {
      const settings = event.config.settings.filter((setting) => !DUPLICATED_SETTING_IDS.has(setting.id));
      emit({ ...event, config: { ...event.config, settings } });
      return;
    }
    // A pod that went away takes the agent process with it; resume on the replacement instead of
    // telling Paseo the session died.
    if (event.type === "session.runtime_failed" && event.sessionId === sessionId && ps.opened && !ps.closing) {
      console.log(`[kube-agents] agent process failed in ${ps.sandbox}: ${event.error.message}${event.error.diagnostic ? ` (${event.error.diagnostic})` : ""}`);
      void recover(sessionId, ps);
      return;
    }
    // Reopening on a replacement pod is internal: Paseo already has this session open. A failed reopen is
    // kept so the caller can report it instead of carrying on with a session the agent never opened.
    if (ps.reopenWaiter && "requestId" in event && event.requestId === ps.reopenWaiter.requestId) {
      if (event.type === "request.failed") ps.reopenWaiter.settle(new Error(event.error.message));
      else if (event.type === "session.ready" || event.type === "session.opened") ps.reopenWaiter.settle();
    }
    if ("requestId" in event && typeof event.requestId === "string" && event.requestId.startsWith("recover-")) return;
    if (ps.reopening && (event.type === "session.opened" || event.type === "session.ready")) return;
    // The ACP runtime cannot take Paseo's tool policy, so tools preapproved on the daemon are
    // answered here instead of prompting inside the pod. Everything else reaches Paseo as usual.
    if (event.type === "session.permission" && event.sessionId === sessionId) {
      const actionId = allowActionId(event.request);
      if (actionId && isPreapproved(ps.toolPolicy, [event.request.name, event.request.title])) {
        void inner
          .send({
            type: "session.permission",
            sessionId,
            permissionId: event.request.id,
            response: { behavior: "allow", selectedActionId: actionId },
          })
          .catch(() => emit(event));
        return;
      }
    }
    if (event.type === "session.permission" && event.sessionId === sessionId) ps.pendingPermissions++;
    emit(toLocal(event, sessionId, ps.podCwd, ps.localCwd, capabilities, ps.handle));
  }

  /** Waits for the pod, makes sure the workspace is there, and reopens the agent's session in it. */
  async function reopenOnPod(sessionId: string, ps: PodSession): Promise<void> {
    await wait(ps.sandbox, (problem) => notice(sessionId, "warning", problem));
    const repo = await (deps.detectRepo ?? detectRepo)(ps.localCwd);
    await ensureWorkspace(ps, repo, parseClonePlan(ps.config.env));
    startPodBridge(ps);
    const inner = await startInner(sessionId, ps);
    ps.reopening = true;
    const requestId = `recover-${Date.now()}`;
    // The agent process opens the session after `send` returns: wait until it says so, or the first
    // message would reach a session that does not exist yet.
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settle(new Error("the agent did not open its session in time")), 190_000);
      const settle = (error?: Error) => {
        clearTimeout(timer);
        ps.reopenWaiter = undefined;
        error ? reject(error) : resolve();
      };
      ps.reopenWaiter = { requestId, settle };
    });
    opened.catch(() => undefined);
    try {
      await inner.send({
        type: "session.open",
        requestId,
        sessionId,
        config: ps.config,
        history: "skip",
        ...(ps.persistence ? { persistence: ps.persistence } : {}),
      } as ProviderInput);
      await opened;
    } catch (error) {
      ps.reopenWaiter?.settle(error as Error);
      throw new Error(`the agent could not reopen its session: ${(error as Error).message}`);
    } finally {
      ps.reopening = false;
    }
  }

  const persistent = config.storage.mode === "persistent";

  /** Deletes the pod of an idle agent and keeps its volume; the next input brings it back. */
  async function suspend(sessionId: string, ps: PodSession): Promise<void> {
    if (ps.state !== "running" || ps.recovering || ps.closing) return;
    track(sessionId, ps, "suspended");
    ps.stopForwarding();
    ps.bridge?.close();
    await ps.inner.close().catch(() => undefined);
    try {
      await kube.patchSandbox(ps.sandbox, suspendPatch(ps.used));
      notice(sessionId, "info", "Pod suspended after sitting idle. It comes back when you send a message; the workspace is kept.");
    } catch (error) {
      // Could not suspend: the agent process is gone, so bring it back rather than leave a half state.
      notice(sessionId, "warning", `Could not suspend the pod: ${(error as Error).message}`);
      await resume(sessionId, ps).catch(() => undefined);
    }
  }

  /**
   * Recreates the pod on the same volume (current image and settings) and resumes the agent's session
   * from its saved handle. One resume at a time per agent: inputs that arrive meanwhile wait for it.
   */
  /** Creates (or claims from the warm pool) the sandbox of a session that has been open without one. */
  async function materialize(sessionId: string, ps: PodSession): Promise<void> {
    deps.pool?.noteRequest();
    const handleId = nativeSessionId(ps.handle);
    const warm = await deps.pool?.claim(sessionId, ps.agentId, handleId).catch(() => null);
    const name = warm ?? sandboxName(sessionId, repoName(ps.repo.url), ps.slug);
    if (!warm) await kube.apply(buildSandbox({ name, sessionId, config, daemonId: deps.daemonId, agentId: ps.agentId, handleId }));
    ps.sandbox = name;
    ps.podCwd = podWorkdir(name);
    ps.config = { ...ps.config, cwd: ps.podCwd };
    ps.deferred = false;
    ps.fresh = true;
  }

  /**
   * Brings the agent's pod up and resumes its session from the saved handle: the first message of a new
   * agent (the sandbox is created now), or any input after a suspension (the pod is recreated on the same
   * volume). One at a time per agent: inputs that arrive meanwhile wait for it.
   */
  function resume(sessionId: string, ps: PodSession): Promise<void> {
    if (ps.state === "running") return Promise.resolve();
    ps.resuming ??= (async () => {
      const wasDeferred = ps.deferred;
      track(sessionId, ps, "resuming", wasDeferred);
      notice(sessionId, "info", wasDeferred ? "Starting the pod..." : "Resuming the pod...");
      try {
        if (wasDeferred) await materialize(sessionId, ps);
        else await kube.patchSandbox(ps.sandbox, resumePatch(config, ps.used));
        track(sessionId, ps, "resuming");
        await reopenOnPod(sessionId, ps);
        ps.lastActivity = now();
        ps.opened = true;
        track(sessionId, ps, "running");
        notice(sessionId, "info", wasDeferred ? "Pod started" : "Pod resumed");
      } catch (error) {
        ps.bridge?.close();
        await ps.inner?.close().catch(() => undefined);
        if (wasDeferred && ps.fresh && ps.sandbox) {
          // Nothing of the agent's lives there yet: remove the sandbox and start from scratch next time.
          await deleteSandbox(ps.sandbox).catch(() => undefined);
          deps.registry?.delete(sessionId);
          ps.sandbox = "";
          ps.deferred = true;
          ps.fresh = false;
          ps.state = "suspended";
        } else {
          // Back to suspended (and the pod released) so the next input retries from a clean state.
          await kube.patchSandbox(ps.sandbox, suspendPatch(ps.used)).catch(() => undefined);
          track(sessionId, ps, "suspended");
        }
        const message = (error as Error).message;
        notice(sessionId, "error", `Could not ${wasDeferred ? "start" : "resume"} the pod: ${message}`);
        throw new Error(`kube-agents: could not ${wasDeferred ? "start" : "resume"} the pod: ${message}. Send a message again to retry.`);
      } finally {
        ps.resuming = undefined;
      }
    })();
    return ps.resuming;
  }

  /** Suspends every agent that has been idle for `podIdleMinutes`. */
  async function checkIdle(): Promise<void> {
    const limit = config.podIdleMinutes * 60_000;
    if (!persistent || limit <= 0) return;
    for (const [sessionId, ps] of sessions) {
      const idle = !ps.turnId && ps.pendingPermissions === 0 && ps.opened && now() - ps.lastActivity >= limit;
      if (ps.state === "running" && idle) {
        console.log(`[kube-agents] suspending idle pod ${ps.sandbox} (idle ${Math.round((now() - ps.lastActivity) / 1000)}s)`);
        await suspend(sessionId, ps);
      }
    }
  }
  if (persistent && config.podIdleMinutes > 0) console.log(`[kube-agents] idle suspension on: pods idle ${config.podIdleMinutes} min are suspended`);
  const stopTicker = (deps.ticker ?? ((fn, ms) => {
    const timer = setInterval(fn, ms) as unknown as NodeJS.Timeout;
    timer.unref?.();
    return () => clearInterval(timer);
  }))(() => void checkIdle().catch(() => undefined), 30_000);

  async function recover(sessionId: string, ps: PodSession): Promise<void> {
    if (ps.recovering || ps.closing || closed) return;
    const clock = (deps.now ?? Date.now)();
    ps.recoveries = ps.recoveries.filter((t) => clock - t < RECOVERY_WINDOW_MS);
    if (ps.recoveries.length >= MAX_RECOVERIES) {
      emit({
        type: "session.runtime_failed",
        sessionId,
        error: { message: `kube-agents: the agent keeps failing in its pod (${MAX_RECOVERIES} restarts in 10 minutes)` },
      });
      return;
    }
    ps.recoveries.push(clock);
    ps.recovering = true;
    const lost = ps.inner;
    ps.stopForwarding();
    ps.bridge?.close();
    if (ps.turnId) {
      emit({
        type: "session.turn",
        sessionId,
        turnId: ps.turnId,
        state: "failed",
        error: { message: "The pod was lost during this turn; the agent restarted on a new pod." },
      });
      ps.turnId = undefined;
    }
    notice(sessionId, "warning", "Pod lost, waiting for a replacement");
    try {
      await lost.close().catch(() => undefined);
      await reopenOnPod(sessionId, ps);
      notice(sessionId, "info", "Reconnected on a new pod");
    } catch (error) {
      emit({
        type: "session.runtime_failed",
        sessionId,
        error: { message: `kube-agents: could not recover the session: ${(error as Error).message}` },
      });
    } finally {
      ps.reopening = false;
      ps.recovering = false;
    }
  }

  /** Answers Paseo's open request without a pod: the session is ready, and the catalog stands in for the agent's own config. */
  async function announceOpen(input: Extract<ProviderInput, { type: "session.open" }>, ps: PodSession): Promise<void> {
    const { sessionId, config: session } = input;
    const cat = await catalog();
    emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId,
      capabilities,
      restoration: "core",
      persistence: ps.handle,
      cwd: ps.localCwd,
      ...(session.title ? { title: session.title } : {}),
    });
    emit({
      type: "session.config",
      sessionId,
      config: {
        ...(session.model ? { model: session.model } : cat.defaultModel ? { model: cat.defaultModel } : {}),
        ...(session.mode ? { mode: session.mode } : cat.defaultMode ? { mode: cat.defaultMode } : {}),
        ...(session.thinkingOption ? { thinkingOption: session.thinkingOption } : {}),
        models: cat.models,
        modes: cat.modes,
        thinkingOptions: cat.thinkingOptions ?? [],
        settings: [],
      },
    });
    emit({ type: "session.ready", requestId: input.requestId, sessionId });
  }

  async function open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const { sessionId, config: session } = input;
    console.log(`[kube-agents] opening session persist=${session.persist} history=${input.history} resumed=${Boolean(input.persistence)}`);
    const repo = await (deps.detectRepo ?? detectRepo)(session.cwd);
    const plan = parseClonePlan(session.env);
    const { toolPolicy: _unenforceable, ...forwarded } = session;

    // The agent may already have a sandbox: the plugin restarted, or the agent was suspended. Adopt it,
    // so its volume (workspace and the agent's own session state) comes back with it.
    const agentId = session.env.PASEO_KUBE_AGENT_ID || undefined;
    const native = nativeSessionId(input.persistence);
    const handleId = native ?? sessionId;
    const handle: ProviderPersistence = input.persistence ?? { version: 1, data: { sessionId } };
    const existing =
      (await kube.listSandboxes(`${SESSION_LABEL}=${sessionLabel(sessionId)}`).catch(() => []))[0] ??
      (native ? (await kube.listSandboxes(`${NATIVE_LABEL}=${sessionLabel(native)}`).catch(() => []))[0] : undefined);
    const slug = session.env[REF_ENV_KEYS.slug];
    const base = {
      localCwd: session.cwd,
      repo,
      plan,
      agentId,
      slug,
      toolPolicy: session.toolPolicy,
      inner: undefined as unknown as ProviderConnection,
      stopForwarding: () => undefined,
      handle,
      used: Boolean(input.persistence),
      lastActivity: now(),
      pendingPermissions: 0,
      prep: Promise.resolve(),
      recovering: false,
      reopening: false,
      closing: false,
      recoveries: [] as number[],
    };

    // Opening a session costs nothing: Paseo opens many that never run (drafts, feature previews, every
    // agent again after a daemon restart). The pod is created, or the suspended one resumed, by the first message.
    if (!deps.eager && existing?.operatingMode !== "Running") {
      const podCwd = existing ? podWorkdir(existing.name) : "";
      const lazy: PodSession = {
        ...base,
        sandbox: existing?.name ?? "",
        deferred: !existing,
        podCwd,
        config: { ...forwarded, cwd: podCwd },
        persistence: acpHandle(existing?.annotations) ?? input.persistence,
        state: "suspended",
        opened: true,
      };
      sessions.set(sessionId, lazy);
      if (existing) track(sessionId, lazy, "suspended");
      await announceOpen(input, lazy);
      return;
    }

    let name: string;
    let created = false;
    if (existing) {
      name = existing.name;
    } else {
      deps.pool?.noteRequest();
      const warm = await deps.pool?.claim(sessionId, agentId, handleId).catch(() => null);
      if (warm) {
        name = warm;
      } else {
        name = sandboxName(sessionId, repoName(repo.url), slug);
        await kube.apply(buildSandbox({ name, sessionId, config, daemonId: deps.daemonId, agentId, handleId }));
      }
      created = true;
    }
    const podCwd = podWorkdir(name);
    const ps: PodSession = {
      ...base,
      persistence: acpHandle(existing?.annotations) ?? input.persistence,
      sandbox: name,
      deferred: false,
      podCwd,
      config: { ...forwarded, cwd: podCwd },
      state: "running",
      opened: false,
    };
    try {
      if (existing?.operatingMode === "Suspended") await kube.patchSandbox(name, resumePatch(config, ps.used));
      else if (ps.used) await kube.patchSandbox(name, usedPatch()).catch(() => undefined);
      await wait(name);
      await ensureWorkspace(ps, repo, plan);
      startPodBridge(ps);
      await startInner(sessionId, ps);
      sessions.set(sessionId, ps);
      // The agent process is opened with its own handle (kept on the sandbox), never the one Paseo saved.
      const { persistence: _paseoHandle, ...openInput } = input;
      await ps.inner.send({ ...openInput, ...(ps.persistence ? { persistence: ps.persistence } : {}), config: { ...forwarded, cwd: podCwd } });
      ps.opened = true;
      ps.lastActivity = now();
      track(sessionId, ps, "running");
    } catch (error) {
      sessions.delete(sessionId);
      deps.registry?.delete(sessionId);
      ps.stopForwarding();
      ps.bridge?.close();
      await ps.inner?.close().catch(() => undefined);
      // Only a sandbox made for this request is removed; an adopted one keeps the agent's workspace.
      if (created) await deleteSandbox(name).catch(() => undefined);
      throw error;
    }
  }

  /** Deleting the Sandbox cascades to the pod and its claim; the claim is also deleted explicitly. */
  async function deleteSandbox(name: string): Promise<void> {
    await kube.delete("sandbox", name);
    await kube.delete("pvc", workspaceClaimName(name)).catch(() => undefined);
  }

  async function release(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.closing = true;
    sessions.delete(sessionId);
    deps.registry?.delete(sessionId);
    session.stopForwarding();
    session.bridge?.close();
    await session.inner?.close().catch(() => undefined);
    if (!session.deferred && session.sandbox) await deleteSandbox(session.sandbox);
  }

  return {
    version: PROTOCOL_VERSION,
    capabilities,
    async send(input) {
      if (closed) throw new Error("kube-agents connection is closed");
      switch (input.type) {
        case "catalog":
          emit({ type: "catalog", requestId: input.requestId, catalog: await catalog() });
          return;
        case "sessions":
          emit({ type: "sessions", requestId: input.requestId, sessions: [] });
          return;
        case "session.open": {
          const pending = open(input).catch((error: Error) => {
            emit({
              type: "request.failed",
              requestId: input.requestId,
              error: { message: `kube-agents: ${error.message}` },
            });
          });
          opening.set(input.sessionId, pending);
          await pending;
          opening.delete(input.sessionId);
          return;
        }
        case "session.close": {
          await opening.get(input.sessionId);
          const session = sessions.get(input.sessionId);
          if (session) {
            session.closing = true;
            if (session.state === "running") await session.inner.send(input).catch(() => undefined);
          }
          try {
            await release(input.sessionId);
            emit({ type: "request.completed", requestId: input.requestId });
          } catch (error) {
            emit({
              type: "request.failed",
              requestId: input.requestId,
              error: { message: `kube-agents: failed to delete sandbox: ${(error as Error).message}` },
            });
          }
          return;
        }
        default: {
          if (!("sessionId" in input)) throw new Error(`kube-agents does not support ${input.type}`);
          await opening.get(input.sessionId);
          const session = sessions.get(input.sessionId);
          if (!session) throw new Error(`Unknown session ${input.sessionId}`);
          if (session.recovering) throw new Error("The pod is being replaced; try again once it has reconnected");
          // Nothing is running while suspended, so there is nothing to interrupt and no pod worth waking.
          if (input.type === "session.interrupt" && session.state !== "running") {
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          session.lastActivity = now();
          // Preparation (marking the agent used, waking the pod) runs one input at a time, first come first
          // served, so inputs reach the agent in the order they arrived. Delivery itself is not serialized:
          // an interrupt or a permission answer must not wait behind a running turn.
          const prepared = session.prep.then(async () => {
            await resume(input.sessionId, session); // a no-op while running; creates the pod of a new agent
            if (input.type === "session.prompt" && !session.used) {
              session.used = true;
              // From the first prompt the agent's sandbox and volume no longer expire; only archiving removes them.
              await kube.patchSandbox(session.sandbox, usedPatch()).catch(() => undefined);
            }
          });
          session.prep = prepared.catch(() => undefined);
          await prepared;
          await session.inner.send(input);
        }
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      stopTicker();
      await Promise.allSettled([...opening.values()]);
      // Closing the connection is not archiving an agent. With a persistent volume the pods are suspended
      // (volume kept) and the next session.open finds them again; an ephemeral workspace has nothing to keep.
      await Promise.allSettled(
        [...sessions.entries()].map(async ([sessionId, ps]) => {
          if (!persistent || !ps.used) return release(sessionId);
          sessions.delete(sessionId);
          deps.registry?.delete(sessionId);
          ps.closing = true;
          ps.stopForwarding();
          ps.bridge?.close();
          await ps.inner?.close().catch(() => undefined);
          if (ps.state !== "suspended" && ps.sandbox) await kube.patchSandbox(ps.sandbox, suspendPatch(ps.used));
        }),
      );
      listeners.clear();
    },
  };
}

/**
 * Pod paths never leak to Paseo: it only knows the daemon-local checkout. A session may only report
 * capabilities the connection advertised, so the agent's own list is clipped to those.
 */
/** The agent process's own handle, as last written to the sandbox. */
function acpHandle(annotations: Record<string, string> | undefined): ProviderPersistence | undefined {
  try {
    const raw = annotations?.[ACP_ANNOTATION];
    return raw ? (JSON.parse(raw) as ProviderPersistence) : undefined;
  } catch {
    return undefined;
  }
}

function toLocal(
  event: ProviderEvent,
  sessionId: string,
  podCwd: string,
  localCwd: string,
  advertised: readonly string[],
  handle: ProviderPersistence,
): ProviderEvent {
  if (event.type === "session.opened" && event.sessionId === sessionId) {
    return {
      ...event,
      persistence: handle,
      cwd: event.cwd === podCwd ? localCwd : event.cwd,
      capabilities: event.capabilities.filter((c) => advertised.includes(c)),
    };
  }
  return event;
}
