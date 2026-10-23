import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../server/config.js";
import { buildSandbox, sandboxName } from "../server/sandbox.js";
import { toHttpsRemote } from "../server/workspace.js";

describe("sandbox manifest", () => {
  const config = ConfigSchema.parse({ templates: { go: { image: "go:1", nodeSelector: { pool: "burst" } } } });

  it("builds a Sandbox in the configured namespace with the template image", () => {
    const sb = buildSandbox({ name: "pka-x", sessionId: "s1", templateName: "go", template: config.templates.go!, config }) as any;
    expect(sb.kind).toBe("Sandbox");
    expect(sb.apiVersion).toBe("agents.x-k8s.io/v1beta1");
    expect(sb.metadata.namespace).toBe("paseo-agent-sandboxes");
    expect(sb.spec.podTemplate.spec.containers[0].image).toBe("go:1");
    expect(sb.spec.podTemplate.spec.nodeSelector).toEqual({ pool: "burst" });
    expect(sb.spec.lifecycle.shutdownPolicy).toBe("Delete");
  });

  it("injects credentials from a Secret, never inline", () => {
    const sb = buildSandbox({ name: "n", sessionId: "s", templateName: "default", template: {}, config }) as any;
    const c = sb.spec.podTemplate.spec.containers[0];
    expect(c.envFrom[0].secretRef.name).toBe("paseo-agent-credentials");
    expect(c.env).toBeUndefined();
  });

  it("makes DNS-safe names", () => {
    expect(sandboxName("Sess_ID/With Weird!")).toMatch(/^pka-sess-id-with-weird-[0-9a-f]{6}$/);
  });
});

describe("toHttpsRemote", () => {
  it("rewrites ssh remotes", () => {
    expect(toHttpsRemote("git@github.com:lerenn/x.git")).toBe("https://github.com/lerenn/x.git");
    expect(toHttpsRemote("ssh://git@github.com/lerenn/x.git")).toBe("https://github.com/lerenn/x.git");
    expect(toHttpsRemote("https://github.com/a/b")).toBe("https://github.com/a/b");
  });
});
