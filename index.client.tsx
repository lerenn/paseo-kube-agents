import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { KubeAgentsScreen } from "./client/screen.js";

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
    client.addScreen({ id: "settings", title: "Kube agents", Component: KubeAgentsScreen }),
    client.addSidebarHeaderItem({ id: "kube-agents", title: "Kube agents", Component: KubeAgentsItem }),
  ];
  return () => removers.forEach((remove) => remove());
}
