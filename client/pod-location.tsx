import type { ComponentType } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsSelect, SettingsCard } from "@getpaseo/plugin/client/ui";
import { useSettings } from "@getpaseo/plugin/client";
import { refEnv } from "../shared/pod-ref.js";
import { credentialsStatus } from "../shared/credentials.js";
import { kubeSettings, TEMPLATE_ENV } from "../shared/settings.js";

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
  Settings?: ComponentType<{
    project: WorkspaceLocationProject;
    value: unknown;
    onChange(value: unknown): void;
    disabled: boolean;
  }>;
  defaultValue?: unknown;
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

export function podSettingsValue(value: unknown): string {
  return typeof value === "string" && value ? value : "default";
}

/** GitHub token plus the Claude OAuth token: without both, a pod agent cannot clone or run. */
export function credentialsReady(set: Record<string, boolean>): boolean {
  return set.GH_TOKEN === true && set.CLAUDE_CODE_OAUTH_TOKEN === true;
}

function TemplateSelect(props: { value: unknown; onChange(value: unknown): void; disabled: boolean }) {
  const settings = useSettings(kubeSettings);
  if (settings.status !== "ready") return null;
  const names = ["default", ...Object.keys(settings.values.templates).filter((n) => n !== "default")];
  if (names.length < 2) return null;
  return (
    <SettingsCard>
      <SettingsSelect
        label="Pod template"
        value={podSettingsValue(props.value)}
        options={names.map((name) => ({ label: name, value: name }))}
        onValueChange={props.onChange}
        disabled={props.disabled}
      />
    </SettingsCard>
  );
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
    defaultValue: "default",
    usesRef: true,
    isAvailable() {
      if (Date.now() - lastRefresh > REFRESH_MS) refresh();
      return ready;
    },
    Settings: TemplateSelect,
    async createWorkspace({ project, settings, idempotencyKey, prompt, slug, ref }) {
      const status = await client.rpc(credentialsStatus, {});
      if (!credentialsReady(status.set)) {
        throw new Error("Set GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN in the Kube Agents screen first.");
      }
      const workspace = await client.paseo.workspaces.create({
        source: { kind: "directory", path: project.directory, projectId: project.id },
        title: `${project.name}-${slug}`,
        idempotencyKey,
      });
      const template = podSettingsValue(settings);
      const agent = await workspace.agents.create({
        config: { provider: POD_AGENT_PROVIDER },
        env: { ...(template === "default" ? {} : { [TEMPLATE_ENV]: template }), ...refEnv(ref, slug) },
        prompt,
        idempotencyKey,
      });
      return { workspaceId: workspace.id, agentId: agent.id };
    },
  });
  return remove;
}
