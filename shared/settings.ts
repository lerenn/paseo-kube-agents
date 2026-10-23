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

export const ConfigSchema = z.object({
  /** kubectl context. Unset uses the current context of the daemon's kubeconfig. */
  context: z.string().optional(),
  namespace: z.string().default(DEFAULT_NAMESPACE),
  /** apiVersion of the agent-sandbox `Sandbox` CRD. */
  sandboxApiVersion: z.string().default("agents.x-k8s.io/v1beta1"),
  defaultImage: z.string().default(DEFAULT_IMAGE),
  /** Command that runs an ACP agent over stdio inside the pod. */
  agentCommand: z.array(z.string()).min(1).default(["claude-agent-acp"]),
  /** Secret (keys become env vars: GH_TOKEN, ANTHROPIC_API_KEY, ...) mounted by envFrom. */
  credentialsSecret: z.string().default("paseo-agent-credentials"),
  readyTimeoutSeconds: z.number().int().positive().default(300),
  /** Hard cap on pod lifetime, in seconds, enforced by the Sandbox controller. */
  maxLifetimeSeconds: z.number().int().positive().default(8 * 3600),
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
