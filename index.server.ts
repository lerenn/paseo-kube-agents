import type { PluginServerContext } from "@getpaseo/plugin/server";
import { credentialsRemove, credentialsSet, credentialsStatus } from "./shared/credentials.js";
import { ConfigSchema, kubeSettings } from "./shared/settings.js";
import { readStatus, removeCredential, setCredential } from "./server/credentials.js";
import { Kubectl } from "./server/kube.js";
import { createProvider } from "./server/provider.js";
import { WarmPool } from "./server/pool.js";
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
  const pool = new WarmPool({
    getConfig,
    kubeFor: (c) => new Kubectl({ context: c.context, namespace: c.namespace }),
  });
  pool.start();
  server.registerProvider(createProvider(getConfig, { pool, registry }));
  server.handle(kubeStatus, async () => ({
    pool: await pool.status(),
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
  return () => pool.stop();
}
