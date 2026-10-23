import {
  type KubeAgentsConfig,
  type TemplateConfig,
  TEMPLATE_ENV,
} from "../shared/settings.js";

export * from "../shared/settings.js";

/** The one per-agent setting: session env first, then the daemon env, else "default". */
export function resolveTemplateName(
  sessionEnv: Readonly<Record<string, string>>,
  daemonEnv: NodeJS.ProcessEnv = process.env,
): string {
  return sessionEnv[TEMPLATE_ENV] || daemonEnv[TEMPLATE_ENV] || "default";
}

export function resolveTemplate(config: KubeAgentsConfig, name: string): TemplateConfig {
  const template = config.templates[name];
  if (template) return template;
  if (name === "default") return { warmPool: { enabled: false, size: 1, idleTimeoutSeconds: 900 } };
  const known = ["default", ...Object.keys(config.templates).filter((k) => k !== "default")];
  throw new Error(`Unknown ${TEMPLATE_ENV} "${name}". Known templates: ${known.join(", ")}`);
}
