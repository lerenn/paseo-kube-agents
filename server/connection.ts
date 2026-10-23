import type {
  ProviderConnection,
  ProviderConnectRequest,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { AcpConnector } from "@getpaseo/plugin/server/acp";
import {
  type KubeAgentsConfig,
  resolveTemplate,
  resolveTemplateName,
} from "./config.js";
import type { Kube } from "./kube.js";
import { buildSandbox, sandboxName } from "./sandbox.js";
import { cloneIntoPod, detectRepo, podWorkdir, type RepoRef } from "./workspace.js";

const PROTOCOL_VERSION = 1;
const SUPPORTED_CAPABILITIES = ["prompt.message", "prompt.command", "session.configure", "permission"];

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
    const templateName = resolveTemplateName(session.env);
    const template = resolveTemplate(config, templateName);
    const repo = await (deps.detectRepo ?? detectRepo)(session.cwd);
    const name = sandboxName(sessionId);
    const podCwd = podWorkdir(name);

    await kube.apply(buildSandbox({ name, sessionId, templateName, template, config }));
    let inner: ProviderConnection | undefined;
    try {
      await kube.waitReady("sandbox", name, config.readyTimeoutSeconds);
      await cloneIntoPod(kube, name, repo, podCwd);

      const connector: AcpConnector = () => kube.execStream(name, [...config.agentCommand]);
      inner = await deps.acpProvider(connector).connect({
        versions: request.versions,
        capabilities: request.capabilities,
      });
      const stopForwarding = inner.onEvent((event) => emit(toLocal(event, sessionId, podCwd, session.cwd)));
      sessions.set(sessionId, { sandbox: name, localCwd: session.cwd, podCwd, inner, stopForwarding });
      await inner.send({ ...input, config: { ...session, cwd: podCwd } });
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
          emit({ type: "catalog", requestId: input.requestId, catalog: { models: [], modes: [] } });
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
          await release(input.sessionId);
          emit({ type: "request.completed", requestId: input.requestId });
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

/** Pod paths never leak to Paseo: it only knows the daemon-local checkout. */
function toLocal(event: ProviderEvent, sessionId: string, podCwd: string, localCwd: string): ProviderEvent {
  if (event.type === "session.opened" && event.sessionId === sessionId) {
    return { ...event, cwd: event.cwd === podCwd ? localCwd : event.cwd };
  }
  return event;
}
