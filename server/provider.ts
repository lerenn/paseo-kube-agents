import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type { KubeAgentsConfig } from "./config.js";
import { connectKube } from "./connection.js";
import { Kubectl } from "./kube.js";

const execFileAsync = promisify(execFile);

/**
 * Registering this provider does nothing on its own: no cluster call is made until an agent is
 * created with provider "kube-agents". `getConfig` is read at connect time so UI changes apply.
 */
export function createProvider(getConfig: () => Promise<KubeAgentsConfig>): ProviderRegistration {
  return {
    id: "kube-agents",
    label: "Kube Agents",
    description: "Runs each agent in its own Kubernetes pod (agent-sandbox).",
    async status() {
      try {
        await execFileAsync("kubectl", ["version", "--client"]);
        return { available: true };
      } catch {
        return { available: false, diagnostic: "kubectl not found on the daemon's PATH" };
      }
    },
    async connect(request) {
      const config = await getConfig();
      const kube = new Kubectl({ context: config.context, namespace: config.namespace });
      return connectKube(request, {
        config,
        kube,
        acpProvider: (connector) =>
          runAcpProvider({
            id: "kube-agents",
            label: "Kube Agents",
            connector,
            acpOptions: { startupTimeoutMs: 180_000 },
          }),
      });
    },
  };
}
