import type {
  ProviderConnection,
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
import { buildSandbox, sandboxName, workspaceClaimName } from "./sandbox.js";
import { REF_ENV_KEYS } from "../shared/pod-ref.js";
import { applyPush, loopbackPorts, startBridge, type RunningBridge } from "./bridge.js";
import { type GitRunner, runGit } from "./git.js";
import { LAUNCH_SCRIPT } from "./pod-assets.js";
import { installAssets, seedWorkspace } from "./pod-setup.js";
import { waitPodReady } from "./pod-wait.js";
import { createSeed, releaseSeed, seedBundle, type Seed } from "./seed.js";
import { detectRepo, parseClonePlan, podWorkdir, repoName, type ClonePlan, type RepoRef } from "./workspace.js";

const PROTOCOL_VERSION = 1;
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
  /** Git on the daemon, with the daemon's own credentials (injected for tests). */
  git?: GitRunner;
  /** Builds the seed bundle from the daemon's checkout (injected for tests). */
  seeder?: (cwd: string, plan: ClonePlan | null, currentBranch: string) => Promise<SeedBundle>;
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
    emit(toLocal(event, sessionId, ps.podCwd, ps.localCwd, capabilities));
  }

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
      await wait(ps.sandbox, (problem) => notice(sessionId, "warning", problem));
      const repo = await (deps.detectRepo ?? detectRepo)(ps.localCwd);
      await ensureWorkspace(ps, repo, parseClonePlan(ps.config.env));
      startPodBridge(ps);
      const inner = await startInner(sessionId, ps);
      ps.reopening = true;
      await inner.send({
        type: "session.open",
        requestId: `recover-${Date.now()}`,
        sessionId,
        config: ps.config,
        history: "skip",
        ...(ps.persistence ? { persistence: ps.persistence } : {}),
      } as ProviderInput);
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
    const name = sandboxName(sessionId, repoName(repo.url), session.env[REF_ENV_KEYS.slug]);
    const podCwd = podWorkdir(name);
    const { toolPolicy: _unenforceable, ...forwarded } = session;

    await kube.apply(buildSandbox({ name, sessionId, config }));
    const ps: PodSession = {
      sandbox: name,
      localCwd: session.cwd,
      podCwd,
      config: { ...forwarded, cwd: podCwd },
      toolPolicy: session.toolPolicy,
      inner: undefined as unknown as ProviderConnection,
      stopForwarding: () => undefined,
      opened: false,
      recovering: false,
      reopening: false,
      closing: false,
      recoveries: [],
    };
    try {
      await wait(name);
      await ensureWorkspace(ps, repo, plan);
      startPodBridge(ps);
      await startInner(sessionId, ps);
      sessions.set(sessionId, ps);
      await ps.inner.send({ ...input, config: { ...forwarded, cwd: podCwd } });
      ps.opened = true;
    } catch (error) {
      sessions.delete(sessionId);
      ps.stopForwarding();
      ps.bridge?.close();
      await ps.inner?.close().catch(() => undefined);
      await deleteSandbox(name).catch(() => undefined);
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
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: {
              models: [{ id: "default", label: "Agent default", isDefault: true }],
              modes: [],
              defaultModel: "default",
            },
          });
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
            await session.inner.send(input).catch(() => undefined);
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
      await Promise.allSettled([...opening.values()]);
      await Promise.allSettled([...sessions.keys()].map(release));
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
