import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { hostBadgeComponent } from "./client/host-badge.js";
import { KubeAgentsScreen } from "./client/screen.js";

const HostBadge = hostBadgeComponent();

function KubeAgentsItem({ currentScreen, openScreen, host }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      // `subtitle` is newer than the pinned plugin types, hence the spread.
      {...(HostBadge ? { subtitle: <HostBadge hostId={host.id} /> } : {})}
      icon="Container"
      active={currentScreen?.screenId === "settings"}
      onPress={() => openScreen({ screenId: "settings" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: "settings", title: "Kube Agents", Component: KubeAgentsScreen }),
    client.addSidebarHeaderItem({ id: "kube-agents", title: "Kube Agents", Component: KubeAgentsItem }),
  ];
  return () => removers.forEach((remove) => remove());
}
