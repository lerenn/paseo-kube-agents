import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_NAMESPACE = "paseo-agents";
export const DEFAULT_IMAGE = "ghcr.io/lerenn/paseo-kube-agents-default:latest";
export const TEMPLATE_ENV = "PASEO_KUBE_TEMPLATE";

/** Stored per template; applied once warm pools ship. Off by default. */
export const WarmPoolSchema = z.object({
  enabled: z.boolean().default(false),
  size: z.number().int().min(0).max(20).default(1),
  idleTimeoutSeconds: z.number().int().min(60).default(900),
});

export const TemplateSchema = z.object({
  /** Container image for this template. Falls back to `defaultImage`. */
  image: z.string().optional(),
  resources: z
    .object({
      requests: z.record(z.string(), z.string()).optional(),
      limits: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  nodeSelector: z.record(z.string(), z.string()).optional(),
  tolerations: z.array(z.record(z.string(), z.unknown())).optional(),
  warmPool: WarmPoolSchema.default({ enabled: false, size: 1, idleTimeoutSeconds: 900 }),
});

/** Where a pod's `/workspace` (clone, HOME and the agent's session state) lives. */
export const StorageSchema = z.object({
  /** `persistent` is a ReadWriteOnce PVC owned by the Sandbox; `ephemeral` is an emptyDir lost with the pod. */
  mode: z.enum(["ephemeral", "persistent"]).default("persistent"),
  /** A Kubernetes quantity, e.g. 10Gi. */
  size: z.string().regex(/^[1-9][0-9]*(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/, "Use a Kubernetes quantity such as 10Gi").default("10Gi"),
  /** Empty (unset) uses the cluster's default StorageClass. */
  storageClassName: z.string().optional(),
});

export const ConfigSchema = z.object({
  /** kubectl context. Unset uses the current context of the daemon's kubeconfig. */
  context: z.string().optional(),
  namespace: z.string().default(DEFAULT_NAMESPACE),
  /** apiVersion of the agent-sandbox `Sandbox` CRD. */
  sandboxApiVersion: z.string().default("agents.x-k8s.io/v1beta1"),
  defaultImage: z.string().default(DEFAULT_IMAGE),
  /** Command that runs an ACP agent over stdio inside the pod. */
  agentCommand: z.array(z.string()).min(1).default(["claude-agent-acp"]),
  /** Secret (keys become env vars: GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) mounted by envFrom. */
  credentialsSecret: z.string().default("paseo-agent-credentials"),
  readyTimeoutSeconds: z.number().int().positive().default(300),
  /** Hard cap on pod lifetime, in seconds, enforced by the Sandbox controller. */
  maxLifetimeSeconds: z.number().int().positive().default(8 * 3600),
  /** Pod placement for every template that does not set its own (e.g. {"lab.anyshift.io/pool": "burst"}). */
  nodeSelector: z.record(z.string(), z.string()).default({}),
  /** Taint keys every pod tolerates (operator Exists), for templates without their own tolerations. */
  tolerationKeys: z.array(z.string()).default([]),
  storage: StorageSchema.default({ mode: "persistent", size: "10Gi" }),
  /** Named pod templates; "default" always exists. */
  templates: z.record(z.string(), TemplateSchema).default({}),
});

export type KubeAgentsConfig = z.infer<typeof ConfigSchema>;
export type TemplateConfig = z.infer<typeof TemplateSchema>;

export const kubeSettings = defineSettings({
  id: "kube",
  scope: "host",
  version: 1,
  schema: ConfigSchema,
});
