import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributePodLocation, credentialsReady, podSettingsValue } from "../client/pod-location.js";

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
const ready = { GH_TOKEN: true, CLAUDE_CODE_OAUTH_TOKEN: true, ANTHROPIC_API_KEY: false, OPENAI_API_KEY: false };

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
    expect(registered[0]).toMatchObject({ id: "pod", title: "Pod", defaultValue: "default" });
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

  it("creates the workspace and a kube-agents agent with the chosen template", async () => {
    const { client, registered, created } = fakeClient(ready);
    contributePodLocation(client);
    const result = await registered[0].createWorkspace({ hostId: "h", project, settings: "go", idempotencyKey: "k", prompt: "do it" });
    expect(result).toEqual({ workspaceId: "w1", agentId: "a1" });
    expect(created.workspace[0].source).toEqual({ kind: "directory", path: "/home/me/repo", projectId: "p1" });
    expect(created.agent[0]).toMatchObject({ config: { provider: "kube-agents" }, env: { PASEO_KUBE_TEMPLATE: "go" }, prompt: "do it" });
  });

  it("sets no template env for the default template", async () => {
    const { client, registered, created } = fakeClient(ready);
    contributePodLocation(client);
    await registered[0].createWorkspace({ hostId: "h", project, settings: "default", idempotencyKey: "k", prompt: "" });
    expect(created.agent[0].env).toEqual({});
  });

  it("refuses to create when credentials are missing", async () => {
    const { client, registered, created } = fakeClient({ ...ready, GH_TOKEN: false });
    contributePodLocation(client);
    await expect(registered[0].createWorkspace({ hostId: "h", project, settings: "default", idempotencyKey: "k", prompt: "" })).rejects.toThrow(/Kube Agents screen/);
    expect(created.workspace).toHaveLength(0);
  });

  it("normalizes the settings value and credential readiness", () => {
    expect(podSettingsValue(undefined)).toBe("default");
    expect(podSettingsValue("go")).toBe("go");
    expect(credentialsReady({ GH_TOKEN: true, ANTHROPIC_API_KEY: true })).toBe(true);
    expect(credentialsReady({ ANTHROPIC_API_KEY: true })).toBe(false);
  });
});
