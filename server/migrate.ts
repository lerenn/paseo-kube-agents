import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OLD_PLUGIN_ID = "kube-agents";
export const NEW_PLUGIN_ID = "kubernetes-runtime";

export interface MigrationResult {
  /** What was copied (relative to Paseo's home). */
  copied: string[];
  /** Where the originals were backed up, when something was copied. */
  backup?: string;
}

/**
 * One-time, non-destructive move of this plugin's data from its old id (`kube-agents`) to the new one: the
 * settings document and the local "credential set" flags. The old files stay where they are (and are copied to a
 * timestamped backup first), so the old install can be removed once the new one is verified.
 */
export function migrateLegacyData(home = join(homedir(), ".paseo"), now = () => new Date()): MigrationResult {
  const pairs: [string, string][] = [
    [join("plugin-settings", OLD_PLUGIN_ID, "kube.json"), join("plugin-settings", NEW_PLUGIN_ID, "kube.json")],
    ["kube-agents-credentials.json", "kubernetes-runtime-credentials.json"],
  ];
  const result: MigrationResult = { copied: [] };
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  for (const [from, to] of pairs) {
    const source = join(home, from);
    const target = join(home, to);
    if (!existsSync(source) || existsSync(target)) continue; // nothing to move, or already moved: never overwrite
    const backup = join(home, "backups", `${OLD_PLUGIN_ID}-${stamp}`, from);
    mkdirSync(join(backup, ".."), { recursive: true });
    copyFileSync(source, backup);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(source, target);
    // verify before reporting success
    if (readFileSync(target, "utf8") !== readFileSync(source, "utf8")) throw new Error(`could not copy ${from}`);
    result.copied.push(from);
    result.backup = join(home, "backups", `${OLD_PLUGIN_ID}-${stamp}`);
  }
  return result;
}
