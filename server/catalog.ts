import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderCatalog, ProviderMode, ProviderModel } from "@getpaseo/plugin/server/provider";

const execFileAsync = promisify(execFile);

/** The modes of the default (claude) adapter; Paseo checks a requested mode against them before the pod exists. */
export const AGENT_MODES: ProviderMode[] = [
  { id: "default", label: "Always ask" },
  { id: "acceptEdits", label: "Accept file edits" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto" },
  { id: "bypassPermissions", label: "Bypass permissions" },
];

/** What `paseo provider models <provider> --json` prints for each model. */
interface CliModel {
  id: string;
  model: string;
  description?: string;
  thinkingOptionIds?: string[];
  defaultThinkingOptionId?: string;
}

export type CliRunner = (args: string[]) => Promise<string>;

const runPaseo: CliRunner = async (args) => (await execFileAsync("paseo", args, { timeout: 20_000 })).stdout;

export const FALLBACK_CATALOG: ProviderCatalog = {
  models: [{ id: "default", label: "Agent default", isDefault: true }],
  modes: AGENT_MODES,
  defaultModel: "default",
  defaultMode: "default",
};

const title = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

export function catalogFromModels(models: readonly CliModel[]): ProviderCatalog {
  if (models.length === 0) return FALLBACK_CATALOG;
  const entries: ProviderModel[] = models.map((m, index) => ({
    id: m.id,
    label: m.model,
    ...(m.description ? { description: m.description } : {}),
    isDefault: index === 0,
    ...(m.thinkingOptionIds?.length
      ? {
          thinkingOptions: m.thinkingOptionIds.map((id) => ({
            id,
            label: title(id),
            isDefault: id === m.defaultThinkingOptionId,
          })),
          ...(m.defaultThinkingOptionId ? { defaultThinkingOptionId: m.defaultThinkingOptionId } : {}),
        }
      : {}),
  }));
  return {
    models: entries,
    modes: AGENT_MODES,
    defaultModel: entries[0]!.id,
    defaultMode: "default",
  };
}

/**
 * The pod agent runs claude, so its picker offers claude's own models and thinking levels, read from
 * the daemon (`paseo provider models claude`) and cached; if that is unavailable the picker falls back to
 * the agent's own default.
 */
export function createCatalogSource(run: CliRunner = runPaseo, ttlMs = 10 * 60 * 1000, now: () => number = Date.now) {
  let cached: { at: number; catalog: ProviderCatalog } | undefined;
  return async (): Promise<ProviderCatalog> => {
    if (cached && now() - cached.at < ttlMs) return cached.catalog;
    try {
      const models = JSON.parse(await run(["provider", "models", "claude", "--json"])) as CliModel[];
      const catalog = catalogFromModels(Array.isArray(models) ? models : []);
      if (catalog !== FALLBACK_CATALOG) cached = { at: now(), catalog };
      return catalog;
    } catch {
      return cached?.catalog ?? FALLBACK_CATALOG;
    }
  };
}
