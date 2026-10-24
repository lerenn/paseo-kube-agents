import { describe, expect, it, vi } from "vitest";
import { AGENT_MODES, FALLBACK_CATALOG, catalogFromModels, createCatalogSource } from "../server/catalog.js";
import { connectKube } from "../server/connection.js";
import { ConfigSchema } from "../shared/settings.js";
import { podAgentConfig, providerDefaults } from "../client/pod-location.js";
import { FakeAcp, FakeKube, fakeSeeder } from "./fakes.js";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

const cli = [
  { id: "claude-opus-5-5", model: "Opus 5.5", description: "Latest", thinkingOptionIds: ["low", "medium", "high"], defaultThinkingOptionId: "medium" },
  { id: "claude-sonnet-5-5", model: "Sonnet 5.5", thinkingOptionIds: ["low", "high"], defaultThinkingOptionId: "high" },
];

describe("provider catalog", () => {
  it("mirrors claude's models and thinking levels, first model as the default", () => {
    const c = catalogFromModels(cli);
    expect(c.models.map((m) => [m.id, m.label, m.isDefault])).toEqual([
      ["claude-opus-5-5", "Opus 5.5", true],
      ["claude-sonnet-5-5", "Sonnet 5.5", false],
    ]);
    expect(c.models[0]!.thinkingOptions!.map((t) => [t.id, t.isDefault])).toEqual([["low", false], ["medium", true], ["high", false]]);
    expect(c.models[0]!.defaultThinkingOptionId).toBe("medium");
    expect(c.defaultModel).toBe("claude-opus-5-5");
    expect(c.modes).toBe(AGENT_MODES);
    expect(c.defaultMode).toBe("default");
  });

  it("is cached, and refreshed after the ttl", async () => {
    const run = vi.fn(async () => JSON.stringify(cli));
    let t = 0;
    const source = createCatalogSource(run, 1000, () => t);
    await source();
    await source();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(["provider", "models", "claude", "--json"]);
    t = 2000;
    await source();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("falls back to the agent default when the daemon cannot be asked, and keeps the last good catalog", async () => {
    const failing = createCatalogSource(async () => { throw new Error("no paseo"); });
    expect(await failing()).toBe(FALLBACK_CATALOG);
    let fail = false;
    let t = 0;
    const source = createCatalogSource(async () => { if (fail) throw new Error("x"); return JSON.stringify(cli); }, 1000, () => t);
    const good = await source();
    fail = true;
    t = 5000;
    expect(await source()).toBe(good);
    expect(await createCatalogSource(async () => "[]")()).toBe(FALLBACK_CATALOG);
  });

  it("is what the connection answers a catalog request with", async () => {
    const events: ProviderEvent[] = [];
    const conn = await connectKube({ versions: [1], capabilities: [] }, { config: ConfigSchema.parse({}), kube: new FakeKube(), acpProvider: new FakeAcp().provider, seeder: fakeSeeder, eager: true, catalog: async () => catalogFromModels(cli) });
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "catalog", requestId: "k" });
    expect((events[0] as any).catalog.models.map((m: any) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  });
});

describe("the composer's defaults", () => {
  const client = (models: any[] | Error) => ({ paseo: { providers: { listModels: async () => { if (models instanceof Error) throw models; return { models }; } } } }) as any;

  it("fills in the provider's default model and its default thinking level when the composer left them out", async () => {
    const defaults = await providerDefaults(client([{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5", isDefault: true, defaultThinkingOptionId: "medium" }]), "claude");
    expect(defaults).toEqual({ model: "claude-opus-5-5", thinkingOptionId: "medium" });
    // exactly what Louis's composer sent: a provider and a mode, nothing else
    expect(podAgentConfig({ provider: "claude", modeId: "bypassPermissions" }, defaults)).toEqual({
      provider: "kube-agents/claude-opus-5-5",
      thinkingOptionId: "medium",
      modeId: "bypassPermissions",
    });
  });

  it("an explicit choice wins; an explicit model does not inherit another model's thinking default", () => {
    const defaults = { model: "claude-opus-5-5", thinkingOptionId: "medium" };
    expect(podAgentConfig({ provider: "claude", model: "claude-sonnet-5-5", thinkingOptionId: "high" }, defaults)).toEqual({ provider: "kube-agents/claude-sonnet-5-5", thinkingOptionId: "high" });
    expect(podAgentConfig({ provider: "claude", model: "claude-sonnet-5-5" }, defaults)).toEqual({ provider: "kube-agents/claude-sonnet-5-5" });
  });

  it("falls back to the agent default when the model list cannot be read", async () => {
    expect(await providerDefaults(client(new Error("offline")), "claude")).toEqual({});
    expect(await providerDefaults(client([]), "claude")).toEqual({});
    expect(await providerDefaults(client([]), undefined)).toEqual({});
    expect(podAgentConfig(null)).toEqual({ provider: "kube-agents/default" });
  });
});
