import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { type KubeAgentsConfig, loadConfig } from "./config.js";
import { connectKube } from "./connection.js";
import { Kubectl } from "./kube.js";

const execFileAsync = promisify(execFile);

export function createProvider(config: KubeAgentsConfig = loadConfig()): ProviderRegistration {
  const kube = new Kubectl({ context: config.context, namespace: config.namespace });
  return {
    id: "kube-agents",
    label: "Kube agents",
    description: "Runs each agent in its own Kubernetes pod (agent-sandbox).",
    async status() {
      try {
        await execFileAsync("kubectl", ["version", "--client"]);
        return { available: true };
      } catch {
        return { available: false, diagnostic: "kubectl not found on the daemon's PATH" };
      }
    },
    connect: (request) =>
      connectKube(request, {
        config,
        kube,
        acpProvider: (connector) =>
          runAcpProvider({ id: "kube-agents", label: "Kube agents", connector }),
      }),
  };
}
