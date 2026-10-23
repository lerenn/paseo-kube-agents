import { describe, expect, it } from "vitest";
import { formatGitSource } from "../shared/git-source.js";

describe("formatGitSource", () => {
  it("shortens GitHub ssh and https remotes to owner/repo@ref", () => {
    expect(formatGitSource("git@github.com:anyshift-io/lfradin-lab.git", "main")).toBe("anyshift-io/lfradin-lab@main");
    expect(formatGitSource("https://github.com/anyshift-io/lfradin-lab", "main")).toBe("anyshift-io/lfradin-lab@main");
    expect(formatGitSource("https://github.com/anyshift-io/lfradin-lab.git/", "v1")).toBe("anyshift-io/lfradin-lab@v1");
    expect(formatGitSource("ssh://git@github.com/o/r.git", "dev")).toBe("o/r@dev");
    expect(formatGitSource("https://user:tok@github.com/o/r.git", "main")).toBe("o/r@main");
  });

  it("keeps the host for non-GitHub remotes", () => {
    expect(formatGitSource("git@gitlab.com:group/sub/repo.git", "main")).toBe("gitlab.com/group/sub/repo@main");
    expect(formatGitSource("https://git.example.com:8443/o/r.git", "x")).toBe("git.example.com/o/r@x");
  });

  it("omits @ref when there is none and passes unparseable input through", () => {
    expect(formatGitSource("git@github.com:o/r.git")).toBe("o/r");
    expect(formatGitSource("not a url", "main")).toBe("not a url@main");
  });
});
