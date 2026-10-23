import type {
  ProviderConnection,
  ProviderConnectRequest,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
  ProviderToolPolicy,
} from "@getpaseo/plugin/server/provider";
import type { AcpConnector } from "@getpaseo/plugin/server/acp";
import type { KubeAgentsConfig } from "./config.js";
import type { Kube } from "./kube.js";
import { buildSandbox, sandboxName } from "./sandbox.js";
import { REF_ENV_KEYS } from "../shared/pod-ref.js";
import { cloneIntoPod, detectRepo, parseClonePlan, podWorkdir, repoName, type RepoRef } from "./workspace.js";

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
}

interface PodSession {
  sandbox: string;
  localCwd: string;
  podCwd: string;
  inner: ProviderConnection;
  stopForwarding: () => void;
}

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

  async function open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const { sessionId, config: session } = input;
    const repo = await (deps.detectRepo ?? detectRepo)(session.cwd);
    const plan = parseClonePlan(session.env);
    const name = sandboxName(sessionId, repoName(repo.url), session.env[REF_ENV_KEYS.slug]);
    const podCwd = podWorkdir(name);

    await kube.apply(buildSandbox({ name, sessionId, config }));
    let inner: ProviderConnection | undefined;
    try {
      await kube.waitReady("sandbox", name, config.readyTimeoutSeconds);
      await cloneIntoPod(kube, name, repo, podCwd, plan);

      const connector: AcpConnector = () => kube.execStream(name, [...config.agentCommand]);
      inner = await deps.acpProvider(connector).connect({
        versions: request.versions,
        capabilities: request.capabilities,
      });
      const policy = session.toolPolicy;
      const stopForwarding = inner.onEvent((event) => {
        // The ACP runtime cannot enforce Paseo's tool policy, so tools preapproved on the daemon are
        // answered here instead of prompting inside the pod. Everything else reaches Paseo as usual.
        if (event.type === "session.permission" && event.sessionId === sessionId) {
          const actionId = allowActionId(event.request);
          if (actionId && isPreapproved(policy, [event.request.name, event.request.title])) {
            void inner!
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
        emit(toLocal(event, sessionId, podCwd, session.cwd, capabilities));
      });
      sessions.set(sessionId, { sandbox: name, localCwd: session.cwd, podCwd, inner, stopForwarding });
      const { toolPolicy: _unenforceable, ...forwarded } = session;
      await inner.send({ ...input, config: { ...forwarded, cwd: podCwd } });
    } catch (error) {
      sessions.delete(sessionId);
      await inner?.close().catch(() => undefined);
      await kube.delete("sandbox", name).catch(() => undefined);
      throw error;
    }
  }

  async function release(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    session.stopForwarding();
    await session.inner.close().catch(() => undefined);
    await kube.delete("sandbox", session.sandbox);
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
          if (session) await session.inner.send(input).catch(() => undefined);
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
