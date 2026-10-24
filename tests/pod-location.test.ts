import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributePodLocation, credentialsReady } from "../client/pod-location.js";

const project = { id: "p1", name: "repo", directory: "/home/me/repo" };

function fakeClient(set: Record<string, boolean>, withApi = true) {
  const registered: any[] = [];
  const created: any[] = [];
  const client: any = {
    rpc: vi.fn(async () => ({ set })),
    paseo: {
      workspaces: {
        create: async (options: any) => {
          created.push(options);
          return { id: "w1" };
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

  it("registers a Pod option that keeps the branch picker, and removes it on cleanup", () => {
    const { client, registered } = fakeClient(ready);
    const cleanup = contributePodLocation(client);
    expect(registered[0]).toMatchObject({ id: "pod", title: "Pod", usesRef: true });
    expect(registered[0].Settings).toBeUndefined(); // nothing to choose: one pod configuration
    cleanup();
    expect(registered).toHaveLength(0);
  });

  it("is available only once the Claude token is set", async () => {
    const ok = fakeClient(ready);
    contributePodLocation(ok.client);
    await flush();
    expect(ok.registered[0].isAvailable({ hostId: "h", project })).toBe(true);
    const missing = fakeClient({ CLAUDE_CODE_OAUTH_TOKEN: false });
    contributePodLocation(missing.client);
    await flush();
    expect(missing.registered[0].isAvailable({ hostId: "h", project })).toBe(false);
  });

  it("creates the workspace in the Kubernetes runtime and lets Paseo start the first agent, so it is a real claude or codex agent", async () => {
    const { client, registered, created } = fakeClient(ready);
    contributePodLocation(client);
    const result = await registered[0].createWorkspace({
      hostId: "h", project, settings: undefined, idempotencyKey: "k", prompt: "Hello there!", slug: "brave-otter-12",
      ref: { action: "branch-off", refName: "refs/heads/main" },
    });
    expect(result).toEqual({ workspaceId: "w1" }); // no agentId: Paseo starts the agent with the composer's provider, model, thinking and mode
    expect(created[0]).toEqual({
      source: { kind: "directory", path: "/home/me/repo", projectId: "p1" },
      title: "repo-brave-otter-12",
      idempotencyKey: "k",
      runtime: { id: "kubernetes", options: { cwd: "/home/me/repo", slug: "brave-otter-12", ref: { action: "branch-off", refName: "refs/heads/main" }, title: "repo-brave-otter-12" } },
    });
  });

  it("passes a null ref through when the picker was not shown", async () => {
    const { client, registered, created } = fakeClient(ready);
    contributePodLocation(client);
    await registered[0].createWorkspace({ hostId: "h", project, settings: undefined, idempotencyKey: "k", prompt: "", slug: "s1", ref: null });
    expect(created[0].runtime.options.ref).toBeNull();
  });

  it("refuses to create when the token went missing", async () => {
    const { client, registered, created } = fakeClient({ CLAUDE_CODE_OAUTH_TOKEN: false });
    contributePodLocation(client);
    await expect(registered[0].createWorkspace({ hostId: "h", project, settings: undefined, idempotencyKey: "k", prompt: "", slug: "s", ref: null })).rejects.toThrow(/Kubernetes Runtime screen/);
    expect(created).toHaveLength(0);
  });

  it("readiness needs the Claude token only: GitHub needs no pod credential", () => {
    expect(credentialsReady({ CLAUDE_CODE_OAUTH_TOKEN: true })).toBe(true);
    expect(credentialsReady({})).toBe(false);
    expect(credentialsReady({ CLAUDE_CODE_OAUTH_TOKEN: false })).toBe(false);
  });
});
