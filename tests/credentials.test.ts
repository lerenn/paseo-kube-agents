import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStatus, secretPatch, setCredential } from "../server/credentials.js";
import { FakeKube } from "./fakes.js";

const statePath = () => join(mkdtempSync(join(tmpdir(), "kube-cred-")), "state.json");

describe("credentials", () => {
  it("builds a merge patch with a base64 value, valid when the Secret has no data yet", () => {
    expect(JSON.parse(secretPatch("GH_TOKEN", "ghp_x"))).toEqual({
      data: { GH_TOKEN: Buffer.from("ghp_x").toString("base64") },
    });
  });

  it("sends a merge patch on stdin, not argv", async () => {
    const calls: string[][] = [];
    const { Kubectl } = await import("../server/kube.js");
    class Spy extends Kubectl {
      async ok(args: string[], stdin?: string) {
        calls.push([...args, stdin ?? ""]);
        return { code: 0, stdout: "", stderr: "" };
      }
    }
    await new Spy({ namespace: "paseo-agents" }).patchSecret("s", secretPatch("GH_TOKEN", "tok"));
    expect(calls[0]!.slice(0, 5)).toEqual(["patch", "secret", "s", "--type=merge", "--patch-file=/dev/stdin"]);
    expect(calls[0]!.slice(0, 5).join(" ")).not.toContain(Buffer.from("tok").toString("base64"));
  });

  it("starts with every key not set", () => {
    expect(readStatus(statePath())).toEqual({
      GH_TOKEN: false, CLAUDE_CODE_OAUTH_TOKEN: false, ANTHROPIC_API_KEY: false, OPENAI_API_KEY: false,
    });
  });

  it("patches the named Secret and records only a boolean", async () => {
    const kube = new FakeKube();
    const path = statePath();
    const status = await setCredential(kube, "paseo-agent-credentials", "OPENAI_API_KEY", "sk-secret", path);
    expect(kube.patches[0]!.name).toBe("paseo-agent-credentials");
    expect(status.OPENAI_API_KEY).toBe(true);
    expect(status.GH_TOKEN).toBe(false);
    expect(readFileSync(path, "utf8")).not.toContain("sk-secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readStatus(path).OPENAI_API_KEY).toBe(true);
  });

  it("does not mark a key set, or leak the value, when the patch fails", async () => {
    const kube = new FakeKube();
    kube.patchError = new Error("forbidden: body sk-secret rejected");
    const path = statePath();
    await expect(setCredential(kube, "s", "GH_TOKEN", "sk-secret", path)).rejects.toThrow(/\*\*\*/);
    await expect(setCredential(kube, "s", "GH_TOKEN", "sk-secret", path)).rejects.not.toThrow(/sk-secret/);
    expect(readStatus(path).GH_TOKEN).toBe(false);
  });

  it("rejects values with newlines before touching the cluster", async () => {
    const kube = new FakeKube();
    await expect(setCredential(kube, "s", "GH_TOKEN", "a\nb", statePath())).rejects.toThrow(/newlines/);
    expect(kube.patches).toHaveLength(0);
  });
});
