import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributePodLocation, credentialsReady, podAgentConfig } from "../client/pod-location.js";

const project = { id: "p1", name: "repo", directory: "/home/me/repo" };

function fakeClient(set: Record<string, boolean>, withApi = true) {
  const registered: any[] = [];
  const created = { workspace: [] as any[], agent: [] as any[] };
  const client: any = {
    rpc: vi.fn(async () => ({ set })),
    paseo: {
      workspaces: {
        create: async (o: any) => {
          created.workspace.push(o);
          return {
            id: "w1",
            agents: {
              create: async (a: any) => {
                created.agent.push(a);
                return { id: "a1" };
              },
            },
          };
        },
      },
    },
  };
  if (withApi) {
    client.addWorkspaceLocation = (c: any) => {
      registered.push(c);
      return () => registered.splice(0);
    };
  }
  return { client: client as PluginClientContext, registered, created };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const ready = { CLAUDE_CODE_OAUTH_TOKEN: true };

describe("pod workspace location", () => {
  it("is a no-op, without crashing, on a Paseo without addWorkspaceLocation", () => {
    const { client, registered } = fakeClient(ready, false);
    const cleanup = contributePodLocation(client);
    expect(registered).toHaveLength(0);
    expect(() => cleanup()).not.toThrow();
  });

  it("registers a Pod option and removes it on cleanup", () => {
    const { client, registered } = fakeClient(ready);
    const cleanup = contributePodLocation(client);
    expect(registered[0]).toMatchObject({ id: "pod", title: "Pod" });
    expect(registered[0].Settings).toBeUndefined(); // one pod configuration: nothing to choose
    cleanup();
    expect(registered).toHaveLength(0);
  });

  it("is available only once GH_TOKEN and a Claude credential are set", async () => {
    const ok = fakeClient(ready);
    contributePodLocation(ok.client);
    await flush();
    expect(ok.registered[0].isAvailable({ hostId: "h", project })).toBe(true);

    const missing = fakeClient({ ...ready, CLAUDE_CODE_OAUTH_TOKEN: false });
    contributePodLocation(missing.client);
    await flush();
    expect(missing.registered[0].isAvailable({ hostId: "h", project })).toBe(false);
  });

  it("creates the workspace and a kube-agents agent from the picked ref", async () => {
    const { client, registered, created } = fakeClient(ready);
    contributePodLocation(client);
    const result = await registered[0].createWorkspace({ hostId: "h", project, settings: undefined, idempotencyKey: "k", prompt: "do it", slug: "brave-otter-12", ref: { action: "branch-off", refName: "refs/heads/main" } });
    expect(result).toEqual({ workspaceId: "w1", agentId: "a1" });
    expect(created.workspace[0].title).toBe("repo-brave-otter-12");
    expect(registered[0].usesRef).toBe(true);
    expect(created.workspace[0].source).toEqual({ kind: "directory", path: "/home/me/repo", projectId: "p1" });
    expect(created.agent[0]).toMatchObject({ config: { provider: "kube-agents/default" }, env: { PASEO_KUBE_SLUG: "brave-otter-12", PASEO_KUBE_ACTION: "branch-off", PASEO_KUBE_REF: "refs/heads/main" }, prompt: "do it" });
  });

  it("starts the agent on provider/model, as the daemon requires, from the New workspace form's inputs", async () => {
    const { client, registered, created } = fakeClient(ready);
    contributePodLocation(client);
    // The exact inputs the form produced: project "Paseo Fork", default settings, prompt "Hello there!".
    await registered[0].createWorkspace({
      hostId: "anyshift-lab",
      project: { id: "p9", name: "Paseo Fork", directory: "/home/paseo/src/paseo" },
      settings: undefined,
      idempotencyKey: "draft-1",
      prompt: "Hello there!",
      slug: "brave-otter-12",
      ref: { action: "branch-off", refName: "refs/heads/main" },
    });
    expect(created.agent[0].config.provider).toMatch(/^[^/]+\/[^/]+$/);
    expect(created.agent[0].config.provider).toBe("kube-agents/default");
    expect(created.agent[0].prompt).toBe("Hello there!");
  });

  it("refuses to create when credentials are missing", async () => {
    const { client, registered, created } = fakeClient({ CLAUDE_CODE_OAUTH_TOKEN: false });
    contributePodLocation(client);
    await expect(registered[0].createWorkspace({ hostId: "h", project, settings: "default", idempotencyKey: "k", prompt: "", slug: "s", ref: null })).rejects.toThrow(/Kube Agents screen/);
    expect(created.workspace).toHaveLength(0);
  });

  it("starts the pod agent with the composer's model, thinking level and mode", async () => {
    const { client, registered, created } = fakeClient(ready);
    contributePodLocation(client);
    await registered[0].createWorkspace({
      hostId: "h", project, settings: undefined, idempotencyKey: "k", prompt: "Hello there!", slug: "happy-blobfish", ref: null,
      agent: { provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "medium", modeId: "bypassPermissions", featureValues: { fast: true } },
    });
    expect(created.agent[0].config).toEqual({ provider: "kube-agents/claude-opus-5-5", thinkingOptionId: "medium", modeId: "bypassPermissions" });
  });

  it("falls back to the agent default when the composer sent nothing", () => {
    expect(podAgentConfig(null)).toEqual({ provider: "kube-agents/default" });
    expect(podAgentConfig({ provider: "claude" })).toEqual({ provider: "kube-agents/default" });
  });

  it("normalizes the settings value and credential readiness", () => {
    expect(credentialsReady({ CLAUDE_CODE_OAUTH_TOKEN: true })).toBe(true);
    expect(credentialsReady({})).toBe(false); // GitHub needs no pod credential
    expect(credentialsReady({ CLAUDE_CODE_OAUTH_TOKEN: false })).toBe(false);
  });
});
