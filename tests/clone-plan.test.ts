import { describe, expect, it } from "vitest";
import { refEnv } from "../shared/pod-ref.js";
import { sandboxName } from "../server/sandbox.js";
import { parseClonePlan, repoName, shortBranch } from "../server/workspace.js";

describe("clone plan", () => {
  it("round-trips the branch picker choice through env", () => {
    const env = refEnv({ action: "branch-off", refName: "refs/heads/main" }, "brave-otter-12");
    expect(parseClonePlan(env)).toEqual({ action: "branch-off", branch: "main", slug: "brave-otter-12" });
    const pr = refEnv({ action: "checkout", refName: "feat/x", changeRequest: { forge: "github", number: 42 } }, "s");
    expect(parseClonePlan(pr)).toEqual({ action: "checkout", branch: "feat/x", pullRequest: 42, slug: "s" });
    expect(parseClonePlan(refEnv(null, "s"))).toBeNull();
    expect(parseClonePlan({})).toBeNull();
  });

  it("strips ref prefixes", () => {
    expect(shortBranch("refs/heads/main")).toBe("main");
    expect(shortBranch("refs/remotes/origin/feat/x")).toBe("feat/x");
    expect(shortBranch("origin/main")).toBe("main");
  });

  it("names pods from the repository and slug, DNS-safe and short", () => {
    expect(repoName("https://github.com/lerenn/paseo-kube-agents.git")).toBe("paseo-kube-agents");
    const name = sandboxName("sess", "paseo-kube-agents", "brave-otter-12");
    expect(name).toMatch(/^pka-paseo-kube-agents-brave-otter-12-[0-9a-f]{6}$/);
    expect(sandboxName("x".repeat(80), "R".repeat(80), "S_".repeat(40)).length).toBeLessThanOrEqual(63);
    expect(sandboxName("Sess_ID")).toMatch(/^pka-sess-id-[0-9a-f]{6}$/);
  });
});
