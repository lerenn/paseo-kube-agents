import { describe, expect, it } from "vitest";
import { refEnv } from "../shared/pod-ref.js";
import { sandboxName } from "../server/sandbox.js";
import { cloneIntoPod, parseClonePlan, repoName, shortBranch } from "../server/workspace.js";
import { FakeKube } from "./fakes.js";

const repo = { url: "https://github.com/lerenn/x.git", branch: "dev" };

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

  it("without a plan clones the checkout's current branch", async () => {
    const kube = new FakeKube();
    await cloneIntoPod(kube, "p", repo, "/workspace/p");
    expect(kube.execs).toHaveLength(1);
    expect(kube.execs[0]!.argv.slice(-3)).toEqual(["dev", repo.url, "/workspace/p"]);
  });

  it("branch-off clones the base then creates the slug branch", async () => {
    const kube = new FakeKube();
    await cloneIntoPod(kube, "p", repo, "/workspace/p", { action: "branch-off", branch: "main", slug: "brave-otter-12" });
    expect(kube.execs[0]!.argv.slice(-3)).toEqual(["main", repo.url, "/workspace/p"]);
    expect(kube.execs[1]!.argv.slice(-2)).toEqual(["/workspace/p", "brave-otter-12"]);
    expect(kube.execs[1]!.argv[2]).toContain("checkout -b");
  });

  it("checkout of a branch clones that branch only", async () => {
    const kube = new FakeKube();
    await cloneIntoPod(kube, "p", repo, "/workspace/p", { action: "checkout", branch: "feat/x" });
    expect(kube.execs).toHaveLength(1);
    expect(kube.execs[0]!.argv.slice(-3)).toEqual(["feat/x", repo.url, "/workspace/p"]);
  });

  it("checkout of a pull request fetches its head", async () => {
    const kube = new FakeKube();
    await cloneIntoPod(kube, "p", repo, "/workspace/p", { action: "checkout", pullRequest: 42 });
    expect(kube.execs[1]!.argv.slice(-2)).toEqual(["/workspace/p", "42"]);
    expect(kube.execs[1]!.argv[2]).toContain("pull/$2/head");
  });

  it("reports which step failed", async () => {
    const kube = new FakeKube();
    kube.execResult = { code: 1, stdout: "", stderr: "nope" };
    await expect(cloneIntoPod(kube, "p", repo, "/w", { action: "checkout", pullRequest: 1 })).rejects.toThrow(/git clone.*nope/);
  });

  it("names pods from the repository and slug, DNS-safe and short", () => {
    expect(repoName("https://github.com/lerenn/paseo-kube-agents.git")).toBe("paseo-kube-agents");
    const name = sandboxName("sess", "paseo-kube-agents", "brave-otter-12");
    expect(name).toMatch(/^pka-paseo-kube-agents-brave-otter-12-[0-9a-f]{6}$/);
    expect(sandboxName("x".repeat(80), "R".repeat(80), "S_".repeat(40)).length).toBeLessThanOrEqual(63);
    expect(sandboxName("Sess_ID")).toMatch(/^pka-sess-id-[0-9a-f]{6}$/);
  });
});
