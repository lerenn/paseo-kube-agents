import { describe, expect, it } from "vitest";
import { ConfigSchema, resolveTemplate, resolveTemplateName } from "../server/config.js";

describe("config", () => {
  it("defaults to the paseo-agents namespace", () => {
    expect(ConfigSchema.parse({}).namespace).toBe("paseo-agents");
  });

  it("reads the template from session env, then daemon env, else default", () => {
    expect(resolveTemplateName({ PASEO_KUBE_TEMPLATE: "go" }, { PASEO_KUBE_TEMPLATE: "node" })).toBe("go");
    expect(resolveTemplateName({}, { PASEO_KUBE_TEMPLATE: "node" })).toBe("node");
    expect(resolveTemplateName({}, {})).toBe("default");
  });

  it("rejects unknown templates and lists the known ones", () => {
    const config = ConfigSchema.parse({ templates: { go: { image: "x" } } });
    expect(resolveTemplate(config, "go").image).toBe("x");
    expect(resolveTemplate(config, "default").image).toBeUndefined();
    expect(() => resolveTemplate(config, "rust")).toThrow(/Known templates: default, go/);
  });
});

describe("settings schema", () => {
  it("parses an empty document into a complete config", () => {
    const c = ConfigSchema.parse({});
    expect(c.templates).toEqual({});
    expect(c.credentialsSecret).toBe("paseo-agent-credentials");
  });

  it("defaults warm pools to off and small", () => {
    const c = ConfigSchema.parse({ templates: { go: { image: "go:1" } } });
    expect(c.templates.go?.warmPool).toEqual({ enabled: false, size: 1, idleTimeoutSeconds: 900 });
    expect(resolveTemplate(c, "default").warmPool.enabled).toBe(false);
  });

  it("rejects out-of-range warm pool values", () => {
    expect(() => ConfigSchema.parse({ templates: { go: { warmPool: { size: 99 } } } })).toThrow();
    expect(() => ConfigSchema.parse({ templates: { go: { warmPool: { idleTimeoutSeconds: 5 } } } })).toThrow();
  });
});
