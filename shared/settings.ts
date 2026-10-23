import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_NAMESPACE = "paseo-agents";
export const DEFAULT_IMAGE = "ghcr.io/lerenn/paseo-kube-agents-default:latest";

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
  /** Secret (keys become env vars: GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) mounted by envFrom. */
  credentialsSecret: z.string().default("paseo-agent-credentials"),
  readyTimeoutSeconds: z.number().int().positive().default(300),
  /** Hard cap on pod lifetime, in seconds, enforced by the Sandbox controller. */
  maxLifetimeSeconds: z.number().int().positive().default(8 * 3600),
  /** Pod placement (e.g. {"lab.anyshift.io/pool": "burst"}). */
  nodeSelector: z.record(z.string(), z.string()).default({}),
  /** Taint keys every pod tolerates (operator Exists). */
  tolerationKeys: z.array(z.string()).default([]),
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
