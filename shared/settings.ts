import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_NAMESPACE = "paseo-agents";
export const DEFAULT_IMAGE = "ghcr.io/lerenn/paseo-kube-agents-default:latest";

/** Where a pod's `/workspace` (clone, HOME and the agent's session state) lives. */
export const StorageSchema = z.object({
  /** `persistent` is a ReadWriteOnce PVC owned by the Sandbox; `ephemeral` is an emptyDir lost with the pod. */
  mode: z.enum(["ephemeral", "persistent"]).default("persistent"),
  /** A Kubernetes quantity, e.g. 10Gi. */
  size: z.string().regex(/^[1-9][0-9]*(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/, "Use a Kubernetes quantity such as 10Gi").default("10Gi"),
  /** Empty (unset) uses the cluster's default StorageClass. */
  storageClassName: z.string().optional(),
});

/** Pre-started pods so a new agent does not wait for scheduling. Off by default. */
export const WarmPoolSchema = z.object({
  enabled: z.boolean().default(false),
  size: z.number().int().min(0).max(10).default(1),
  /** No pod agent requested for this long: the pool scales to 0 so burst nodes can go. The next request wakes it. */
  idleMinutes: z.number().int().min(1).default(60),
});

export const ConfigSchema = z.object({
  /** kubectl context. Unset uses the current context of the daemon's kubeconfig. */
  context: z.string().optional(),
  namespace: z.string().default(DEFAULT_NAMESPACE),
  /** apiVersion of the agent-sandbox `Sandbox` CRD. */
  sandboxApiVersion: z.string().default("agents.x-k8s.io/v1beta1"),
  /** Container image for agent pods. */
  image: z.string().default(DEFAULT_IMAGE),
  resources: z
    .object({
      requests: z.record(z.string(), z.string()).optional(),
      limits: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  /** Command that runs an ACP agent over stdio inside the pod. */
  agentCommand: z.array(z.string()).min(1).default(["claude-agent-acp"]),
  /** Secret (keys become env vars: CLAUDE_CODE_OAUTH_TOKEN) mounted by envFrom. */
  credentialsSecret: z.string().default("paseo-agent-credentials"),
  readyTimeoutSeconds: z.number().int().positive().default(300),
  /** Hard cap on pod lifetime, in seconds, enforced by the Sandbox controller. */
  maxLifetimeSeconds: z.number().int().positive().default(8 * 3600),
  /** Pod placement (e.g. {"lab.anyshift.io/pool": "burst"}). */
  nodeSelector: z.record(z.string(), z.string()).default({}),
  /** Taint keys every pod tolerates (operator Exists). */
  tolerationKeys: z.array(z.string()).default([]),
  storage: StorageSchema.default({ mode: "persistent", size: "10Gi" }),
  warmPool: WarmPoolSchema.default({ enabled: false, size: 1, idleMinutes: 60 }),
  /**
   * Also delete this plugin's sandboxes that carry no daemon label (made before labelling existed) and match no
   * agent of this daemon, after 15 minutes. Turn off where several daemons share one namespace.
   */
  sweepUnlabelled: z.boolean().default(true),
  /** An agent idle this long has its pod deleted (the volume stays); any input brings it back. 0 = never. */
  podIdleMinutes: z.number().int().min(0).default(30),
});

export type KubeAgentsConfig = z.infer<typeof ConfigSchema>;

/**
 * v1 had named templates and `defaultImage`. v2 is one flat pod configuration: the old `default`
 * template's image, resources and placement (and `defaultImage`) are folded in, so a running setup
 * keeps the same pods. Other templates and per-template warm pools are dropped.
 */
export function migrateSettings(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= 2 || typeof values !== "object" || values === null) return values;
  const old = values as Record<string, any>;
  const { templates, defaultImage, ...rest } = old;
  const def = templates?.default ?? {};
  const nodeSelector = Object.keys(rest.nodeSelector ?? {}).length > 0 ? rest.nodeSelector : def.nodeSelector;
  const tolerationKeys =
    (rest.tolerationKeys ?? []).length > 0
      ? rest.tolerationKeys
      : (def.tolerations ?? []).map((t: { key?: string }) => t.key).filter((k: unknown): k is string => typeof k === "string");
  return {
    ...rest,
    image: def.image ?? defaultImage ?? rest.image,
    ...(def.resources ? { resources: def.resources } : {}),
    ...(nodeSelector ? { nodeSelector } : {}),
    ...(tolerationKeys.length > 0 ? { tolerationKeys } : {}),
  };
}

export const kubeSettings = defineSettings({
  id: "kube",
  scope: "host",
  version: 2,
  schema: ConfigSchema,
  migrate: migrateSettings,
});
