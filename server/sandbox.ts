import { createHash, randomBytes } from "node:crypto";
import type { KubeAgentsConfig } from "./config.js";

export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const MANAGED_BY = "paseo-kube-agents";
export const WORKSPACE_ROOT = "/workspace";
/** Claude's session state lives under HOME, so HOME is on the workspace volume to survive pod restarts. */
export const HOME_DIR = `${WORKSPACE_ROOT}/.home`;
export const WORKSPACE_VOLUME = "workspace";
/** The Sandbox controller names the claim `<claim template name>-<sandbox name>`. */
export const workspaceClaimName = (sandbox: string) => `${WORKSPACE_VOLUME}-${sandbox}`;

const slugify = (text: string, max: number) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");

/** `pka-<repo>-<slug>-<rand>`, like a worktree named from the repository and a slug; DNS-safe, at most 63 chars. */
export function sandboxName(sessionId: string, repo?: string, slug?: string): string {
  const named = [repo && slugify(repo, 18), slug && slugify(slug, 20)].filter(Boolean).join("-");
  return `pka-${named || slugify(sessionId, 24) || "session"}-${randomBytes(3).toString("hex")}`;
}

export const SESSION_LABEL = "paseo.sh/session";
export const POOL_LABEL = "paseo.sh/pool";
/** The daemon that owns a sandbox (and its volume) and the Paseo agent it belongs to: what the orphan reaper goes by. */
export const DAEMON_LABEL = "paseo.sh/daemon";
export const AGENT_LABEL = "paseo.sh/agent";
/** The agent's own session handle (stable across Paseo reopening the session under a new id). */
export const NATIVE_LABEL = "paseo.sh/native";
/** The agent process's own session handle (JSON), kept privately: Paseo is given the plugin-minted handle instead. */
export const ACP_ANNOTATION = "paseo.sh/acp-handle";

export function nativeSessionId(persistence: { data?: unknown } | undefined): string | undefined {
  const data = persistence?.data;
  return data && typeof data === "object" && typeof (data as { sessionId?: unknown }).sessionId === "string"
    ? (data as { sessionId: string }).sessionId
    : undefined;
}
export const SPEC_HASH_ANNOTATION = "paseo.sh/spec-hash";
/**
 * An agent that was never prompted (a draft the composer opened to preview features, say) is only kept an
 * hour once suspended: abandoned drafts must not hold a volume. An agent in use has no expiry at all: its
 * storage goes only when it is archived (or the orphan reaper finds its agent gone).
 */
export const UNUSED_RETENTION_HOURS = 1;

/** Label-safe, stable handle for a Paseo session id: finds the agent's sandbox again after a restart. */
export const sessionLabel = (sessionId: string) => createHash("sha1").update(sessionId).digest("hex").slice(0, 16);

/** Changes whenever a setting that shapes the pod does, so warm pods built for old settings are recycled. */
export function specHash(config: KubeAgentsConfig): string {
  const shape = {
    image: config.image,
    resources: config.resources ?? null,
    nodeSelector: config.nodeSelector,
    tolerationKeys: config.tolerationKeys,
    storage: config.storage,
    credentialsSecret: config.credentialsSecret,
    apiVersion: config.sandboxApiVersion,
  };
  return createHash("sha1").update(JSON.stringify(shape)).digest("hex").slice(0, 12);
}

export interface SandboxSpecInput {
  name: string;
  sessionId: string;
  config: KubeAgentsConfig;
  /** Build a warm pool sandbox: not tied to a session yet. */
  pool?: boolean;
  /** The owning daemon and Paseo agent, for the orphan reaper. */
  daemonId?: string;
  agentId?: string;
  /** The handle Paseo saved for the agent; labels the sandbox so the agent finds it again. */
  handleId?: string;
}

/** A `Sandbox` (agents.x-k8s.io) whose single container idles; the agent is started by `kubectl exec`. */
export function buildSandbox(input: SandboxSpecInput): Record<string, unknown> {
  const { name, sessionId, config, pool, daemonId, agentId, handleId } = input;
  const labels = {
    [MANAGED_BY_LABEL]: MANAGED_BY,
  };
  const owner = {
    ...(daemonId ? { [DAEMON_LABEL]: daemonId } : {}),
    ...(agentId ? { [AGENT_LABEL]: agentId } : {}),
  };
  const sandboxLabels = pool
    ? { ...labels, ...owner, [POOL_LABEL]: "warm" }
    : { ...labels, ...owner, [SESSION_LABEL]: sessionLabel(sessionId), ...(handleId ? { [NATIVE_LABEL]: sessionLabel(handleId) } : {}) };
  return {
    apiVersion: config.sandboxApiVersion,
    kind: "Sandbox",
    metadata: {
      name,
      namespace: config.namespace,
      labels: sandboxLabels,
      annotations: { ...(pool ? {} : { "paseo.sh/session-id": sessionId }), [SPEC_HASH_ANNOTATION]: specHash(config) },
    },
    spec: {
      shutdownTime: new Date(Date.now() + config.maxLifetimeSeconds * 1000).toISOString(),
      shutdownPolicy: "Delete",
      service: false,
      ...volumeClaims(config, owner),
      podTemplate: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
          ...placement(config),
          containers: [agentContainer(config)],
          // Persistent storage comes from volumeClaimTemplates; the controller adds the volume.
          ...(config.storage.mode === "ephemeral" ? { volumes: [{ name: WORKSPACE_VOLUME, emptyDir: {} }] } : {}),
        },
      },
    },
  };
}

function placement(config: KubeAgentsConfig) {
  const { nodeSelector } = config;
  const tolerations = config.tolerationKeys.map((key) => ({ key, operator: "Exists" }));
  return {
    ...(Object.keys(nodeSelector).length > 0 ? { nodeSelector } : {}),
    ...(tolerations.length > 0 ? { tolerations } : {}),
  };
}

/** A plain ReadWriteOnce claim: no provider-specific fields, so it works on any cluster. */
function volumeClaims(config: KubeAgentsConfig, labels: Record<string, string> = {}) {
  if (config.storage.mode !== "persistent") return {};
  const { size, storageClassName } = config.storage;
  return {
    volumeClaimTemplates: [
      {
        metadata: { name: WORKSPACE_VOLUME, ...(Object.keys(labels).length ? { labels } : {}) },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: size } },
          ...(storageClassName ? { storageClassName } : {}),
        },
      },
    ],
  };
}

/** The pod's single container: idles; the agent is started in it by `kubectl exec`. */
export function agentContainer(config: KubeAgentsConfig) {
  return {
    name: "agent",
    image: config.image,
    command: ["sh", "-c", `mkdir -p "${HOME_DIR}" && exec sleep infinity`],
    workingDir: WORKSPACE_ROOT,
    // Only the Claude token reaches the pod. No `envFrom`: a stale key in the Secret (an old
    // GH_TOKEN, say) must never become a credential in the pod; GitHub goes through the daemon.
    env: [
      { name: "HOME", value: HOME_DIR },
      {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        valueFrom: { secretKeyRef: { name: config.credentialsSecret, key: "CLAUDE_CODE_OAUTH_TOKEN", optional: true } },
      },
    ],
    ...(config.resources ? { resources: config.resources } : {}),
    volumeMounts: [{ name: WORKSPACE_VOLUME, mountPath: WORKSPACE_ROOT }],
  };
}

const hours = (n: number) => new Date(Date.now() + n * 3600 * 1000).toISOString();

/** Deletes the pod and keeps the volume. An agent in use never expires; a draft is kept an hour. */
export function suspendPatch(used = true) {
  return { spec: { operatingMode: "Suspended", shutdownTime: used ? null : hours(UNUSED_RETENTION_HOURS) } };
}

/** Recreates the pod on the same volume, with the current image and settings. A draft gets a fresh lifetime. */
export function resumePatch(config: KubeAgentsConfig, used = true) {
  return {
    metadata: { annotations: { [SPEC_HASH_ANNOTATION]: specHash(config) } },
    spec: {
      operatingMode: "Running",
      shutdownTime: used ? null : new Date(Date.now() + config.maxLifetimeSeconds * 1000).toISOString(),
      podTemplate: { spec: { containers: [agentContainer(config)] } },
    },
  };
}

/** The agent was prompted: from now on its sandbox and volume have no expiry. */
export function usedPatch() {
  return { spec: { shutdownTime: null } };
}

/** Ties a warm sandbox to the agent that claimed it, and gives it a fresh lifetime. */
export function claimPatch(sessionId: string, config: KubeAgentsConfig, agentId?: string, handleId?: string) {
  return {
    metadata: {
      labels: { [POOL_LABEL]: "claimed", [SESSION_LABEL]: sessionLabel(sessionId), ...(agentId ? { [AGENT_LABEL]: agentId } : {}), ...(handleId ? { [NATIVE_LABEL]: sessionLabel(handleId) } : {}) },
      annotations: { "paseo.sh/session-id": sessionId },
    },
    spec: { shutdownTime: new Date(Date.now() + config.maxLifetimeSeconds * 1000).toISOString() },
  };
}
