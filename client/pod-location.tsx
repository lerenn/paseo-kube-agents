import type { PluginClientContext } from "@getpaseo/plugin/client";
import { refEnv } from "../shared/pod-ref.js";
import { credentialsStatus } from "../shared/credentials.js";

/**
 * The fork's `addWorkspaceLocation` is not in the published SDK types, so it is typed here and
 * feature-detected: on a plain upstream Paseo the option simply does not exist.
 */
interface WorkspaceLocationProject {
  id: string;
  name: string;
  directory: string;
}
export interface WorkspaceLocationRef {
  action: "branch-off" | "checkout";
  refName?: string;
  changeRequest?: { forge: string; number: number; projectPath?: string };
}
interface WorkspaceLocationContribution {
  id: string;
  title: string;
  icon: string;
  isAvailable?(context: { hostId: string; project: WorkspaceLocationProject }): boolean;
  /** Show the branch picker (default true). */
  usesRef?: boolean;
  createWorkspace(context: {
    hostId: string;
    project: WorkspaceLocationProject;
    settings: unknown;
    idempotencyKey: string;
    prompt: string;
    slug: string;
    ref: WorkspaceLocationRef | null;
    /** The composer's agent settings; null for an empty workspace. */
    agent?: ComposerAgent | null;
  }): Promise<{ workspaceId: string; agentId?: string }>;
}
type WithWorkspaceLocation = PluginClientContext & {
  addWorkspaceLocation?: (contribution: WorkspaceLocationContribution) => () => void;
};

const REFRESH_MS = 30_000;

/**
 * The daemon requires `provider/model`. Paseo does not pass the composer's model to a workspace
 * location, so the pod agent starts on the agent's own default and the model can be changed from
 * the composer once the session is up.
 */
export const POD_AGENT_PROVIDER = "kube-agents/default";

/** The composer's agent settings, as the fork passes them to a workspace location. */
export interface ComposerAgent {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  featureValues?: Record<string, unknown>;
}

export interface ModelDefaults {
  /** Model the composer's provider uses when none was chosen. */
  model?: string;
  /** Thinking level of that model when none was chosen. */
  thinkingOptionId?: string;
}

/**
 * The composer leaves the model and thinking level out when they are the provider's defaults (the
 * picker still shows them), so those are filled in from the provider's own model list: the pod agent
 * then starts exactly as the composer displays it. Feature values belong to the composer's provider
 * and are not forwarded: the kube-agents provider declares none, so Paseo would reject them.
 */
export function podAgentConfig(agent: ComposerAgent | null | undefined, defaults: ModelDefaults = {}) {
  const model = agent?.model ?? defaults.model;
  const thinkingOptionId = agent?.thinkingOptionId ?? (agent?.model ? undefined : defaults.thinkingOptionId);
  return {
    provider: model ? `kube-agents/${model}` : POD_AGENT_PROVIDER,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(agent?.modeId ? { modeId: agent.modeId } : {}),
  };
}

/** The provider's default model and its default thinking level, from the daemon. Best effort. */
export async function providerDefaults(
  client: Pick<PluginClientContext, "paseo">,
  provider: string | undefined,
): Promise<ModelDefaults> {
  if (!provider) return {};
  try {
    const result = (await client.paseo.providers.listModels(provider)) as {
      models?: { id: string; isDefault?: boolean; defaultThinkingOptionId?: string }[];
    };
    const models = result.models ?? [];
    const chosen = models.find((m) => m.isDefault) ?? models[0];
    return chosen ? { model: chosen.id, thinkingOptionId: chosen.defaultThinkingOptionId } : {};
  } catch {
    return {};
  }
}

/** The Claude OAuth token: without it a pod agent cannot run. GitHub access needs no pod credential. */
export function credentialsReady(set: Record<string, boolean>): boolean {
  return set.CLAUDE_CODE_OAUTH_TOKEN === true;
}

/** Registers "Pod" in the New workspace dropdown. Returns a cleanup; a no-op without the fork API. */
export function contributePodLocation(client: PluginClientContext): () => void {
  const host = client as WithWorkspaceLocation;
  if (typeof host.addWorkspaceLocation !== "function") return () => {};

  let ready = false;
  let lastRefresh = 0;
  const refresh = () => {
    lastRefresh = Date.now();
    client.rpc(credentialsStatus, {}).then(
      (result) => {
        ready = credentialsReady(result.set);
      },
      () => {
        ready = false;
      },
    );
  };
  refresh();

  const remove = host.addWorkspaceLocation({
    id: "pod",
    title: "Pod",
    icon: "Container",
    usesRef: true,
    isAvailable() {
      if (Date.now() - lastRefresh > REFRESH_MS) refresh();
      return ready;
    },
    async createWorkspace({ project, idempotencyKey, prompt, slug, ref, agent: composer }) {
      const status = await client.rpc(credentialsStatus, {});
      if (!credentialsReady(status.set)) {
        throw new Error("Set CLAUDE_CODE_OAUTH_TOKEN in the Kube Agents screen first.");
      }
      const workspace = await client.paseo.workspaces.create({
        source: { kind: "directory", path: project.directory, projectId: project.id },
        title: `${project.name}-${slug}`,
        idempotencyKey,
      });
      const agent = await workspace.agents.create({
        config: podAgentConfig(composer, await providerDefaults(client, composer?.provider)),
        // Opts the pod agent into the GitHub Proxy plugin (if installed), its only route to GitHub.
        env: { PASEO_GITHUB_PROXY: "on", ...refEnv(ref, slug) },
        prompt,
        idempotencyKey,
      });
      return { workspaceId: workspace.id, agentId: agent.id };
    },
  });
  return remove;
}
