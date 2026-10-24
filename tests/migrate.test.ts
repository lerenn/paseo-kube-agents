import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyData } from "../server/migrate.js";

const home = () => mkdtempSync(join(tmpdir(), "kube-migrate-"));
const put = (h: string, rel: string, content: string) => {
  mkdirSync(join(h, rel, ".."), { recursive: true });
  writeFileSync(join(h, rel), content);
};
const when = () => new Date("2026-10-24T12:00:00Z");

describe("moving data from the old plugin id", () => {
  it("copies the settings and the credential flags, backs the originals up, and leaves them in place", () => {
    const h = home();
    put(h, "plugin-settings/kube-agents/kube.json", '{"version":2,"values":{"namespace":"paseo-agents"}}');
    put(h, "kube-agents-credentials.json", '{"CLAUDE_CODE_OAUTH_TOKEN":true}');
    const result = migrateLegacyData(h, when);
    expect(result.copied).toEqual(["plugin-settings/kube-agents/kube.json", "kube-agents-credentials.json"]);
    expect(readFileSync(join(h, "plugin-settings/kubernetes-runtime/kube.json"), "utf8")).toBe('{"version":2,"values":{"namespace":"paseo-agents"}}');
    expect(readFileSync(join(h, "kubernetes-runtime-credentials.json"), "utf8")).toBe('{"CLAUDE_CODE_OAUTH_TOKEN":true}');
    expect(existsSync(join(h, "plugin-settings/kube-agents/kube.json"))).toBe(true); // the old install is removed separately, after verifying
    expect(result.backup).toContain("kube-agents-2026-10-24T12-00-00-000Z");
    expect(readFileSync(join(result.backup!, "plugin-settings/kube-agents/kube.json"), "utf8")).toContain("paseo-agents");
  });

  it("never overwrites data the new id already has, and does nothing the second time", () => {
    const h = home();
    put(h, "plugin-settings/kube-agents/kube.json", "old");
    put(h, "plugin-settings/kubernetes-runtime/kube.json", "new");
    expect(migrateLegacyData(h, when).copied).toEqual([]);
    expect(readFileSync(join(h, "plugin-settings/kubernetes-runtime/kube.json"), "utf8")).toBe("new");
    put(h, "kube-agents-credentials.json", "flags");
    expect(migrateLegacyData(h, when).copied).toEqual(["kube-agents-credentials.json"]);
    expect(migrateLegacyData(h, when).copied).toEqual([]);
  });

  it("is a no-op on a fresh install", () => {
    expect(migrateLegacyData(home(), when)).toEqual({ copied: [] });
  });
});
