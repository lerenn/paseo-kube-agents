import { z } from "zod";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_NAMESPACE = "paseo-agents";
export const DEFAULT_IMAGE = "ghcr.io/lerenn/paseo-kube-agents-default:latest";
export const TEMPLATE_ENV = "PASEO_KUBE_TEMPLATE";

const TemplateSchema = z.object({
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

export function defaultConfigPath(): string {
  return process.env.PASEO_KUBE_CONFIG ?? join(homedir(), ".paseo", "kube-agents.json");
}

export function loadConfig(path = defaultConfigPath()): KubeAgentsConfig {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return ConfigSchema.parse(raw);
}

/** The one per-agent setting: session env first, then the daemon env, else "default". */
export function resolveTemplateName(
  sessionEnv: Readonly<Record<string, string>>,
  daemonEnv: NodeJS.ProcessEnv = process.env,
): string {
  return sessionEnv[TEMPLATE_ENV] || daemonEnv[TEMPLATE_ENV] || "default";
}

export function resolveTemplate(config: KubeAgentsConfig, name: string): TemplateConfig {
  if (name === "default") return config.templates.default ?? {};
  const template = config.templates[name];
  if (!template) {
    const known = ["default", ...Object.keys(config.templates).filter((k) => k !== "default")];
    throw new Error(`Unknown ${TEMPLATE_ENV} "${name}". Known templates: ${known.join(", ")}`);
  }
  return template;
}
