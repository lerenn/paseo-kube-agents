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
    expect(resolveTemplate(config, "default")).toEqual({});
    expect(() => resolveTemplate(config, "rust")).toThrow(/Known templates: default, go/);
  });
});
