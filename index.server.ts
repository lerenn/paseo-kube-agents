import type { PluginServerContext } from "@getpaseo/plugin/server";
import { credentialsSet, credentialsStatus } from "./shared/credentials.js";
import { ConfigSchema, kubeSettings } from "./shared/settings.js";
import { readStatus, setCredential } from "./server/credentials.js";
import { Kubectl } from "./server/kube.js";
import { createProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(kubeSettings);
  const getConfig = async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`kube-agents settings are invalid: ${state.error}`);
    return ConfigSchema.parse(state.values);
  };

  server.registerProvider(createProvider(getConfig));
  server.handle(credentialsStatus, () => ({ set: readStatus() }));
  server.handle(credentialsSet, async ({ key, value }) => {
    const config = await getConfig();
    const kube = new Kubectl({ context: config.context, namespace: config.namespace });
    return { set: await setCredential(kube, config.credentialsSecret, key, value) };
  });
  return () => {};
}
