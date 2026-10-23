import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig, resolveTemplate, resolveTemplateName } from "../server/config.js";

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

describe("loadConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "kube-agents-"));

  it("returns defaults when the file is missing", () => {
    expect(loadConfig(join(dir, "missing.json")).namespace).toBe("paseo-agents");
  });

  it("parses a config file with named templates", () => {
    const path = join(dir, "c.json");
    writeFileSync(path, JSON.stringify({ context: "ctx", templates: { go: { image: "go:1" } } }));
    const config = loadConfig(path);
    expect(config.context).toBe("ctx");
    expect(config.templates.go?.image).toBe("go:1");
    expect(config.agentCommand).toEqual(["claude-agent-acp"]);
  });

  it("rejects invalid files instead of silently using defaults", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ namespace: 5 }));
    expect(() => loadConfig(path)).toThrow();
    writeFileSync(path, "{not json");
    expect(() => loadConfig(path)).toThrow();
  });
});
