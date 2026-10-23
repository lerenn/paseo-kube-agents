import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStatus, secretApply, setCredential } from "../server/credentials.js";
import { FakeKube } from "./fakes.js";

const statePath = () => join(mkdtempSync(join(tmpdir(), "kube-cred-")), "state.json");

describe("credentials", () => {
  it("builds a server-side-apply manifest with a base64 value and no get needed", () => {
    expect(JSON.parse(secretApply("paseo-agent-credentials", "paseo-agents", "GH_TOKEN", "ghp_x"))).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "paseo-agent-credentials", namespace: "paseo-agents" },
      data: { GH_TOKEN: Buffer.from("ghp_x").toString("base64") },
    });
  });

  it("applies server-side with a field manager per key, value on stdin only", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    const { Kubectl } = await import("../server/kube.js");
    class Spy extends Kubectl {
      async ok(args: string[], stdin?: string) {
        calls.push({ args, stdin });
        return { code: 0, stdout: "", stderr: "" };
      }
    }
    const manifest = secretApply("s", "paseo-agents", "GH_TOKEN", "s3cr3t-v4lue");
    await new Spy({ namespace: "paseo-agents" }).applySecretKey("s", "GH_TOKEN", manifest);
    expect(calls[0]!.args).toEqual(["apply", "--server-side", "--field-manager=paseo-kube-agents-gh_token", "--force-conflicts", "-f", "-"]);
    expect(calls[0]!.args.join(" ")).not.toContain("s3cr3t-v4lue");
    expect(calls[0]!.stdin).toBe(manifest);
  });

  it("never uses kubectl patch (it GETs, and the daemon cannot get Secrets)", async () => {
    const { Kubectl } = await import("../server/kube.js");
    const seen: string[][] = [];
    class Spy extends Kubectl {
      async ok(args: string[]) {
        seen.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
    }
    await new Spy({ namespace: "n" }).applySecretKey("s", "OPENAI_API_KEY", "{}");
    expect(seen.flat()).not.toContain("patch");
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
    expect(kube.patches[0]!.key).toBe("OPENAI_API_KEY");
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
