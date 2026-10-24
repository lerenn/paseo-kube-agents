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
import { SESSION_LABEL, buildSandbox, resumePatch, sandboxName, sessionLabel, suspendPatch, workspaceClaimName } from "./sandbox.js";
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
  pool?: { noteRequest(): void; claim(sessionId: string): Promise<string | null> };
  /** Where session states are published for the Kube Agents screen. */
  registry?: PodRegistry;
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
  sandbox: string;
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
  /** False until Paseo's open request has completed; failures before that are not recoverable. */
  opened: boolean;
  recovering: boolean;
  /** True while the agent session is being reopened on a replacement pod. */
  reopening: boolean;
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
  const track = (sessionId: string, ps: PodSession, state: PodState) => {
    ps.state = state;
    deps.registry?.set(sessionId, ps.sandbox, state, now());
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

  function onInnerEvent(sessionId: string, ps: PodSession, inner: ProviderConnection, event: ProviderEvent) {
    if (inner !== ps.inner) return;
    if (event.type === "session.opened" && event.persistence) ps.persistence = event.persistence;
    if (event.type === "session.persistence" && event.sessionId === sessionId) ps.persistence = event.persistence;
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
      void recover(sessionId, ps);
      return;
    }
    // Reopening on a replacement pod is internal: Paseo already has this session open.
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
    emit(toLocal(event, sessionId, ps.podCwd, ps.localCwd, capabilities));
  }

  /** Waits for the pod, makes sure the workspace is there, and reopens the agent's session in it. */
  async function reopenOnPod(sessionId: string, ps: PodSession): Promise<void> {
    await wait(ps.sandbox, (problem) => notice(sessionId, "warning", problem));
    const repo = await (deps.detectRepo ?? detectRepo)(ps.localCwd);
    await ensureWorkspace(ps, repo, parseClonePlan(ps.config.env));
    startPodBridge(ps);
    const inner = await startInner(sessionId, ps);
    ps.reopening = true;
    try {
      await inner.send({
        type: "session.open",
        requestId: `recover-${Date.now()}`,
        sessionId,
        config: ps.config,
        history: "skip",
        ...(ps.persistence ? { persistence: ps.persistence } : {}),
      } as ProviderInput);
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
  function resume(sessionId: string, ps: PodSession): Promise<void> {
    if (ps.state === "running") return Promise.resolve();
    ps.resuming ??= (async () => {
      track(sessionId, ps, "resuming");
      notice(sessionId, "info", "Resuming the pod...");
      try {
        await kube.patchSandbox(ps.sandbox, resumePatch(config));
        await reopenOnPod(sessionId, ps);
        ps.lastActivity = now();
        track(sessionId, ps, "running");
        notice(sessionId, "info", "Pod resumed");
      } catch (error) {
        // Back to suspended (and the pod released) so the next input retries from a clean state.
        ps.bridge?.close();
        await ps.inner?.close().catch(() => undefined);
        await kube.patchSandbox(ps.sandbox, suspendPatch(ps.used)).catch(() => undefined);
        track(sessionId, ps, "suspended");
        const message = (error as Error).message;
        notice(sessionId, "error", `Could not resume the pod: ${message}`);
        throw new Error(`kube-agents: could not resume the pod: ${message}. Send a message again to retry.`);
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

  async function open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const { sessionId, config: session } = input;
    const repo = await (deps.detectRepo ?? detectRepo)(session.cwd);
    const plan = parseClonePlan(session.env);
    const { toolPolicy: _unenforceable, ...forwarded } = session;

    // The agent may already have a sandbox: the plugin restarted, or the agent was suspended. Adopt it,
    // so its volume (workspace and the agent's own session state) comes back with it.
    const existing = (await kube.listSandboxes(`${SESSION_LABEL}=${sessionLabel(sessionId)}`).catch(() => []))[0];
    let name: string;
    let created = false;
    if (existing) {
      name = existing.name;
    } else {
      deps.pool?.noteRequest();
      const warm = await deps.pool?.claim(sessionId).catch(() => null);
      if (warm) {
        name = warm;
      } else {
        name = sandboxName(sessionId, repoName(repo.url), session.env[REF_ENV_KEYS.slug]);
        await kube.apply(buildSandbox({ name, sessionId, config }));
      }
      created = true;
    }
    const podCwd = podWorkdir(name);
    const ps: PodSession = {
      sandbox: name,
      localCwd: session.cwd,
      podCwd,
      config: { ...forwarded, cwd: podCwd },
      toolPolicy: session.toolPolicy,
      inner: undefined as unknown as ProviderConnection,
      stopForwarding: () => undefined,
      state: "running",
      used: Boolean(input.persistence),
      lastActivity: now(),
      pendingPermissions: 0,
      opened: false,
      recovering: false,
      reopening: false,
      closing: false,
      recoveries: [],
    };
    try {
      if (existing?.operatingMode === "Suspended") await kube.patchSandbox(name, resumePatch(config));
      await wait(name);
      await ensureWorkspace(ps, repo, plan);
      startPodBridge(ps);
      await startInner(sessionId, ps);
      sessions.set(sessionId, ps);
      await ps.inner.send({ ...input, config: { ...forwarded, cwd: podCwd } });
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
    await session.inner.close().catch(() => undefined);
    await deleteSandbox(session.sandbox);
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
          if (input.type === "session.prompt") session.used = true;
          await resume(input.sessionId, session); // a no-op while running; inputs during a resume queue behind it
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
          if (ps.state !== "suspended") await kube.patchSandbox(ps.sandbox, suspendPatch(ps.used));
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
function toLocal(
  event: ProviderEvent,
  sessionId: string,
  podCwd: string,
  localCwd: string,
  advertised: readonly string[],
): ProviderEvent {
  if (event.type === "session.opened" && event.sessionId === sessionId) {
    return {
      ...event,
      cwd: event.cwd === podCwd ? localCwd : event.cwd,
      capabilities: event.capabilities.filter((c) => advertised.includes(c)),
    };
  }
  return event;
}
