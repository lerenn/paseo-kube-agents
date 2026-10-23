import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { KubeAgentsScreen } from "./client/screen.js";
import { contributePodLocation } from "./client/pod-location.js";

function KubeAgentsItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Container"
      active={currentScreen?.screenId === "settings"}
      onPress={() => openScreen({ screenId: "settings" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    contributePodLocation(client),
    client.addScreen({ id: "settings", title: "Kube Agents", Component: KubeAgentsScreen }),
    client.addSidebarHeaderItem({ id: "kube-agents", title: "Kube Agents", Component: KubeAgentsItem }),
  ];
  return () => removers.forEach((remove) => remove());
}
