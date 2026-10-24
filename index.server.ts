import type { PluginServerContext } from "@getpaseo/plugin/server";
import { credentialsRemove, credentialsSet, credentialsStatus } from "./shared/credentials.js";
import { ConfigSchema, kubeSettings } from "./shared/settings.js";
import { readStatus, removeCredential, setCredential } from "./server/credentials.js";
import { Kubectl } from "./server/kube.js";
import { createProvider } from "./server/provider.js";
import { WarmPool } from "./server/pool.js";
import { readDaemonId } from "./server/daemon.js";
import { OrphanReaper, readLiveHandles } from "./server/orphans.js";
import { PodRegistry } from "./server/registry.js";
import { kubeStatus } from "./shared/status.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(kubeSettings);
  const getConfig = async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`kube-agents settings are invalid: ${state.error}`);
    return ConfigSchema.parse(state.values);
  };

  const registry = new PodRegistry();
  const daemonId = readDaemonId();
  const kubeFor = (c: { context?: string; namespace: string }) => new Kubectl({ context: c.context, namespace: c.namespace });
  const pool = new WarmPool({
    daemonId,
    getConfig,
    kubeFor,
  });
  pool.start();
  const reaper = new OrphanReaper({
    getConfig,
    kubeFor,
    daemonId,
    liveHandles: async () => readLiveHandles(),
    activeSandboxes: () => new Set(registry.list().map((p) => p.sandbox)),
  });
  reaper.start();
  // The agent id is not part of a provider session; hand it over in the session env so sandboxes can be labelled.
  server.before("agent.session_open", ({ request }) =>
    request.provider === "kube-agents" ? { ...request, env: { ...request.env, PASEO_KUBE_AGENT_ID: request.agentId } } : undefined,
  );
  server.registerProvider(createProvider(getConfig, { pool, registry, daemonId }));
  server.handle(kubeStatus, async () => ({
    pool: await pool.status(),
    reaper: reaper.current(),
    pods: registry.list().map((p) => ({ sessionId: p.sessionId, sandbox: p.sandbox, state: p.state, since: new Date(p.since).toISOString() })),
  }));
  server.handle(credentialsStatus, () => ({ set: readStatus() }));
  server.handle(credentialsSet, async ({ key, value }) => {
    const config = await getConfig();
    const kube = new Kubectl({ context: config.context, namespace: config.namespace });
    return { set: await setCredential(kube, config.credentialsSecret, key, value) };
  });
  server.handle(credentialsRemove, async ({ key }) => {
    const config = await getConfig();
    const kube = new Kubectl({ context: config.context, namespace: config.namespace });
    return { set: await removeCredential(kube, config.credentialsSecret, key) };
  });
  return () => {
    pool.stop();
    reaper.stop();
  };
}
