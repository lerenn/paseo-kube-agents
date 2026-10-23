import { randomBytes } from "node:crypto";
import type { KubeAgentsConfig, TemplateConfig } from "./config.js";

export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const MANAGED_BY = "paseo-kube-agents";
export const WORKSPACE_ROOT = "/workspace";

export function sandboxName(sessionId: string): string {
  const slug = sessionId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return `pka-${slug || "session"}-${randomBytes(3).toString("hex")}`;
}

export interface SandboxSpecInput {
  name: string;
  sessionId: string;
  templateName: string;
  template: TemplateConfig;
  config: KubeAgentsConfig;
}

/** A `Sandbox` (agents.x-k8s.io) whose single container idles; the agent is started by `kubectl exec`. */
export function buildSandbox(input: SandboxSpecInput): Record<string, unknown> {
  const { name, sessionId, templateName, template, config } = input;
  const labels = {
    [MANAGED_BY_LABEL]: MANAGED_BY,
    "paseo.sh/kube-template": templateName,
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
      podTemplate: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
          ...placement(template, config),
          containers: [
            {
              name: "agent",
              image: template.image ?? config.defaultImage,
              command: ["sleep", "infinity"],
              workingDir: WORKSPACE_ROOT,
              envFrom: [{ secretRef: { name: config.credentialsSecret, optional: true } }],
              ...(template.resources ? { resources: template.resources } : {}),
              volumeMounts: [{ name: "workspace", mountPath: WORKSPACE_ROOT }],
            },
          ],
          volumes: [{ name: "workspace", emptyDir: {} }],
        },
      },
    },
  };
}

function placement(template: TemplateConfig, config: KubeAgentsConfig) {
  const nodeSelector = template.nodeSelector ?? config.nodeSelector;
  const tolerations =
    template.tolerations ?? config.tolerationKeys.map((key) => ({ key, operator: "Exists" }));
  return {
    ...(Object.keys(nodeSelector).length > 0 ? { nodeSelector } : {}),
    ...(tolerations.length > 0 ? { tolerations } : {}),
  };
}
