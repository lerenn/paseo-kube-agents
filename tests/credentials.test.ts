import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStatus, secretApply, setCredential } from "../server/credentials.js";
import { FakeKube } from "./fakes.js";

const statePath = () => join(mkdtempSync(join(tmpdir(), "kube-cred-")), "state.json");

describe("credentials", () => {
  it("builds a server-side-apply manifest with a base64 value and no get needed", () => {
    expect(JSON.parse(secretApply("paseo-agent-credentials", "paseo-agents", "CLAUDE_CODE_OAUTH_TOKEN", "ghp_x"))).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "paseo-agent-credentials", namespace: "paseo-agents" },
      data: { CLAUDE_CODE_OAUTH_TOKEN: Buffer.from("ghp_x").toString("base64") },
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
    const manifest = secretApply("s", "paseo-agents", "CLAUDE_CODE_OAUTH_TOKEN", "s3cr3t-v4lue");
    await new Spy({ namespace: "paseo-agents" }).applySecretKey("s", "CLAUDE_CODE_OAUTH_TOKEN", manifest);
    expect(calls[0]!.args).toEqual(["apply", "--server-side", "--field-manager=paseo-kube-agents-claude_code_oauth_token", "--force-conflicts", "-f", "-"]);
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
    await new Spy({ namespace: "n" }).applySecretKey("s", "CLAUDE_CODE_OAUTH_TOKEN", "{}");
    expect(seen.flat()).not.toContain("patch");
  });

  it("starts with every key not set", () => {
    expect(readStatus(statePath())).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: false,
    });
  });

  it("patches the named Secret and records only a boolean", async () => {
    const kube = new FakeKube();
    const path = statePath();
    const status = await setCredential(kube, "paseo-agent-credentials", "CLAUDE_CODE_OAUTH_TOKEN", "sk-secret", path);
    expect(kube.patches[0]!.key).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(status.CLAUDE_CODE_OAUTH_TOKEN).toBe(true);
    expect(readFileSync(path, "utf8")).not.toContain("sk-secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readStatus(path).CLAUDE_CODE_OAUTH_TOKEN).toBe(true);
  });

  it("does not mark a key set, or leak the value, when the patch fails", async () => {
    const kube = new FakeKube();
    kube.patchError = new Error("forbidden: body sk-secret rejected");
    const path = statePath();
    await expect(setCredential(kube, "s", "CLAUDE_CODE_OAUTH_TOKEN", "sk-secret", path)).rejects.toThrow(/\*\*\*/);
    await expect(setCredential(kube, "s", "CLAUDE_CODE_OAUTH_TOKEN", "sk-secret", path)).rejects.not.toThrow(/sk-secret/);
    expect(readStatus(path).CLAUDE_CODE_OAUTH_TOKEN).toBe(false);
  });

  it("rejects values with newlines before touching the cluster", async () => {
    const kube = new FakeKube();
    await expect(setCredential(kube, "s", "CLAUDE_CODE_OAUTH_TOKEN", "a\nb", statePath())).rejects.toThrow(/newlines/);
    expect(kube.patches).toHaveLength(0);
  });
});

import { chmodSync } from "node:fs";
import { Kubectl } from "../server/kube.js";
import { removeCredential } from "../server/credentials.js";

describe("removing a credential", () => {
  const fake = join(process.cwd(), "tests", "fake-kubectl.mjs");

  it("sends a merge patch with null through kubectl proxy, never reading the reply", async () => {
    chmodSync(fake, 0o755);
    const log = join(mkdtempSync(join(tmpdir(), "kube-rm-")), "log");
    process.env.FAKE_KUBECTL_LOG = log;
    delete process.env.FAKE_KUBECTL_STATUS;
    await new Kubectl({ binary: fake, namespace: "paseo-agents", context: "ctx" }).removeSecretKey("paseo-agent-credentials", "CLAUDE_CODE_OAUTH_TOKEN");
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].argv).toEqual(["--context", "ctx", "proxy", "--port=0"]);
    expect(lines[1]).toEqual({
      method: "PATCH",
      url: "/api/v1/namespaces/paseo-agents/secrets/paseo-agent-credentials",
      type: "application/merge-patch+json",
      body: JSON.stringify({ data: { CLAUDE_CODE_OAUTH_TOKEN: null } }),
    });
  });

  it("fails on a refusal without leaking the reply", async () => {
    chmodSync(fake, 0o755);
    process.env.FAKE_KUBECTL_STATUS = "403";
    const err = await new Kubectl({ binary: fake, namespace: "n" }).removeSecretKey("s", "CLAUDE_CODE_OAUTH_TOKEN").catch((e: Error) => e);
    delete process.env.FAKE_KUBECTL_STATUS;
    expect((err as Error).message).toBe("removing CLAUDE_CODE_OAUTH_TOKEN failed: HTTP 403");
    expect((err as Error).message).not.toContain("c2VjcmV0");
  });

  it("clears the local flag only after the cluster accepted the removal", async () => {
    const kube = new FakeKube();
    const path = statePath();
    await setCredential(kube, "s", "CLAUDE_CODE_OAUTH_TOKEN", "tok-1", path);
    kube.removeError = new Error("forbidden");
    await expect(removeCredential(kube, "s", "CLAUDE_CODE_OAUTH_TOKEN", path)).rejects.toThrow("forbidden");
    expect(readStatus(path).CLAUDE_CODE_OAUTH_TOKEN).toBe(true);
    kube.removeError = undefined;
    const status = await removeCredential(kube, "s", "CLAUDE_CODE_OAUTH_TOKEN", path);
    expect(kube.removed).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(status.CLAUDE_CODE_OAUTH_TOKEN).toBe(false);
    expect(readStatus(path).CLAUDE_CODE_OAUTH_TOKEN).toBe(false);
  });
});
