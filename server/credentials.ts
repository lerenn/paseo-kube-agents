import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CREDENTIAL_KEYS, type CredentialKey } from "../shared/credentials.js";
import type { Kube } from "./kube.js";

export function defaultStatePath(): string {
  return join(homedir(), ".paseo", "kube-agents-credentials.json");
}

/**
 * Merge patch that sets one key of a Secret's `data` map (base64, as Secrets require). A merge patch
 * works when `data` is absent, which a JSON-patch `add /data/<key>` does not: the API server drops an empty `data`.
 */
export function secretPatch(key: CredentialKey, value: string): string {
  return JSON.stringify({ data: { [key]: Buffer.from(value).toString("base64") } });
}

export function readStatus(path = defaultStatePath()): Record<string, boolean> {
  let stored: Record<string, boolean> = {};
  try {
    stored = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // no state yet
  }
  return Object.fromEntries(CREDENTIAL_KEYS.map((k) => [k, stored[k] === true]));
}

/**
 * Write-only: patches the Secret and records only a boolean locally. The daemon has no `get` on
 * the Secret, so "set" reflects what this plugin wrote, not the cluster's current state.
 */
export async function setCredential(
  kube: Kube,
  secret: string,
  key: CredentialKey,
  value: string,
  statePath = defaultStatePath(),
): Promise<Record<string, boolean>> {
  if (/[\r\n]/.test(value)) throw new Error("Credential values cannot contain newlines");
  try {
    await kube.patchSecret(secret, secretPatch(key, value));
  } catch (error) {
    // never echo the value, even if kubectl does
    throw new Error((error as Error).message.split(value).join("***"));
  }
  const status = { ...readStatus(statePath), [key]: true };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(status), { mode: 0o600 });
  return status;
}
