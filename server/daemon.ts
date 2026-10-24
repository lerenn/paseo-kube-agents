import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** This daemon's stable id (`srv_...`), as Paseo keeps it; the reaper only touches resources labelled with it. */
export function readDaemonId(home = join(homedir(), ".paseo")): string | undefined {
  try {
    const id = readFileSync(join(home, "server-id"), "utf8").trim();
    return /^[A-Za-z0-9_-]{1,63}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
