import { randomBytes } from "node:crypto";
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

export interface SandboxSpecInput {
  name: string;
  sessionId: string;
  config: KubeAgentsConfig;
}

/** A `Sandbox` (agents.x-k8s.io) whose single container idles; the agent is started by `kubectl exec`. */
export function buildSandbox(input: SandboxSpecInput): Record<string, unknown> {
  const { name, sessionId, config } = input;
  const labels = {
    [MANAGED_BY_LABEL]: MANAGED_BY,
  };
  return {
    apiVersion: config.sandboxApiVersion,
    kind: "Sandbox",
    metadata: {
      name,
      namespace: config.namespace,
      labels,
      annotations: { "paseo.sh/session-id": sessionId },
    },
    spec: {
      shutdownTime: new Date(Date.now() + config.maxLifetimeSeconds * 1000).toISOString(),
      shutdownPolicy: "Delete",
      service: false,
      ...volumeClaims(config),
      podTemplate: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
          ...placement(config),
          containers: [
            {
              name: "agent",
              image: config.image,
              command: ["sh", "-c", `mkdir -p "${HOME_DIR}" && exec sleep infinity`],
              workingDir: WORKSPACE_ROOT,
              env: [{ name: "HOME", value: HOME_DIR }],
              envFrom: [{ secretRef: { name: config.credentialsSecret, optional: true } }],
              ...(config.resources ? { resources: config.resources } : {}),
              volumeMounts: [{ name: WORKSPACE_VOLUME, mountPath: WORKSPACE_ROOT }],
            },
          ],
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
function volumeClaims(config: KubeAgentsConfig) {
  if (config.storage.mode !== "persistent") return {};
  const { size, storageClassName } = config.storage;
  return {
    volumeClaimTemplates: [
      {
        metadata: { name: WORKSPACE_VOLUME },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: size } },
          ...(storageClassName ? { storageClassName } : {}),
        },
      },
    ],
  };
}
