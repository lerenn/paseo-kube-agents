import type { ComponentType } from "react";
import * as ui from "@getpaseo/plugin/client/ui";

/**
 * The app's host badge, or null on an app that predates it (it then shows no badge at all).
 * Read off the namespace so a missing export is `undefined` rather than a load-time error.
 */
export function hostBadgeComponent(
  uiModule: object = ui,
): ComponentType<{ hostId: string }> | null {
  const badge = (uiModule as { HostBadge?: ComponentType<{ hostId: string }> }).HostBadge;
  return typeof badge === "function" || (typeof badge === "object" && badge !== null) ? badge : null;
}
