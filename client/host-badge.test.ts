import { describe, expect, it } from "vitest";
import { hostBadgeComponent } from "./host-badge";

describe("hostBadgeComponent", () => {
  it("returns the app's HostBadge when the app provides it", () => {
    const HostBadge = () => null;
    expect(hostBadgeComponent({ HostBadge })).toBe(HostBadge);
  });

  it("returns null on an app without HostBadge", () => {
    expect(hostBadgeComponent({})).toBeNull();
  });
});
