import type { AcpConnector, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { ExecResult, Kube, PodInfo, SandboxInfo } from "../server/kube.js";

export class FakeKube implements Kube {
  calls: string[] = [];
  applied: Record<string, unknown>[] = [];
  execs: { pod: string; argv: string[] }[] = [];
  execResult: ExecResult = { code: 0, stdout: "", stderr: "" };
  waitError?: Error;
  streams: { pod: string; argv: string[] }[] = [];

  async apply(manifest: Record<string, unknown>) {
    this.calls.push("apply");
    this.applied.push(manifest);
    const meta = (manifest as any).metadata ?? {};
    if (meta.name) {
      this.sandboxes.push({
        name: meta.name,
        labels: meta.labels ?? {},
        annotations: meta.annotations ?? {},
        operatingMode: "Running",
      });
    }
  }
  /** Scripted pod states, consumed in order; the last one repeats. */
  pods: (PodInfo | null)[] = [{ uid: "uid-1", ready: true, terminating: false }];
  async podInfo(name: string) {
    this.calls.push(`pod:${name}`);
    if (this.waitError) throw this.waitError;
    return this.pods.length > 1 ? this.pods.shift()! : this.pods[0]!;
  }
  /** True once the workspace holds a clone (survives a replaced pod when storage is persistent). */
  hasClone = false;
  async exec(pod: string, argv: string[]) {
    this.calls.push("exec");
    this.execs.push({ pod, argv });
    if (argv[0] === "test") return { code: this.hasClone ? 0 : 1, stdout: "", stderr: "" };
    if (this.execResult.code === 0 && argv[0] === "sh" && argv[2]?.includes("git init")) this.hasClone = true;
    return this.execResult;
  }
  inputs: { pod: string; argv: string[]; bytes: number }[] = [];
  async execInput(pod: string, argv: string[], input: import("node:stream").Readable) {
    let bytes = 0;
    for await (const chunk of input) bytes += (chunk as Buffer).length;
    this.calls.push("execInput");
    this.inputs.push({ pod, argv, bytes });
    return this.execResult;
  }
  execStream(pod: string, argv: string[]) {
    this.streams.push({ pod, argv });
    return {
      readable: new ReadableStream<AcpStreamMessage>(),
      writable: new WritableStream<AcpStreamMessage>(),
    };
  }
  namespace = "paseo-agents";
  patches: { key: string; manifest: string }[] = [];
  removed: string[] = [];
  patches2: { name: string; patch: any }[] = [];
  sandboxes: SandboxInfo[] = [];
  async patchSandbox(name: string, patch: Record<string, unknown>) {
    this.calls.push(`patch:${name}`);
    this.patches2.push({ name, patch });
    const sb = this.sandboxes.find((s) => s.name === name);
    const spec = (patch as any).spec;
    if (sb && spec?.operatingMode) sb.operatingMode = spec.operatingMode;
    const meta = (patch as any).metadata;
    if (sb && meta?.labels) sb.labels = { ...sb.labels, ...meta.labels };
    if (sb && meta?.annotations) sb.annotations = { ...sb.annotations, ...meta.annotations };
  }
  async listSandboxes(selector: string) {
    const [k, v] = selector.split("=");
    return this.sandboxes.filter((s) => (v === undefined ? k! in s.labels : s.labels[k!] === v));
  }
  removeError?: Error;
  async removeSecretKey(_secret: string, key: string) {
    if (this.removeError) throw this.removeError;
    this.removed.push(key);
  }
  patchError?: Error;
  async applySecretKey(_secret: string, key: string, manifest: string) {
    if (this.patchError) throw this.patchError;
    this.patches.push({ key, manifest });
  }
  async delete(kind: string, name: string) {
    this.calls.push(`delete:${kind}/${name}`);
    if (kind === "sandbox") this.sandboxes = this.sandboxes.filter((s) => s.name !== name);
  }
}

/** Stands in for the ACP runtime: records inputs, replays a scripted event stream. */
export class FakeAcp {
  inputs: ProviderInput[] = [];
  listeners = new Set<(e: ProviderEvent) => void>();
  closed = false;
  closeCount = 0;
  connector?: AcpConnector;

  provider = (connector: AcpConnector): ProviderRegistration => {
    this.connector = connector;
    return {
      id: "fake",
      label: "fake",
      connect: async (): Promise<ProviderConnection> => ({
        version: 1,
        capabilities: [],
        send: async (input) => {
          this.inputs.push(input);
          if (input.type === "session.open") {
            this.emit({ type: "session.opened", sessionId: input.sessionId, capabilities: ["prompt.image", "session.persistence"], restoration: "core", cwd: input.config.cwd, persistence: { version: 1, data: { sessionId: `native-${input.sessionId}` } } });
            this.emit({ type: "session.ready", sessionId: input.sessionId });
          }
          if (input.type === "session.prompt" && (input.prompt.input as any).content?.[0]?.text === "ask") {
            this.emit({
              type: "session.permission",
              sessionId: input.sessionId,
              request: {
                id: "permission:c1",
                name: "mcp__everything__echo",
                kind: "tool",
                actions: [
                  { id: "allow_always", label: "Always", behavior: "allow" },
                  { id: "allow_once", label: "Once", behavior: "allow" },
                  { id: "reject_once", label: "No", behavior: "deny" },
                ],
              },
            });
            return;
          }
          if (input.type === "session.prompt") {
            this.emit({ type: "session.turn", sessionId: input.sessionId, turnId: "t1", state: "started" });
            this.emit({ type: "timeline.item", sessionId: input.sessionId, item: { id: "m1", type: "assistant_message", text: "hello from pod" } });
            this.emit({ type: "session.turn", sessionId: input.sessionId, turnId: "t1", state: "completed" });
          }
        },
        onEvent: (l) => {
          this.listeners.add(l);
          return () => this.listeners.delete(l);
        },
        close: async () => {
          this.closed = true;
          this.closeCount++;
        },
      }),
    };
  };

  emit(event: ProviderEvent) {
    for (const l of this.listeners) l(event);
  }
}

import { Readable } from "node:stream";
import type { SeedBundle } from "../server/connection.js";

/** Stands in for the daemon-side seed bundle so tests need no git checkout. */
export const fakeSeeder = async (_cwd: string, plan: { branch?: string } | null, currentBranch: string): Promise<SeedBundle> => ({
  seed: { id: "seed1", ref: "refs/kube-seed/seed1", sha: "a".repeat(40), branch: plan?.branch ?? currentBranch },
  bundle: Readable.from([Buffer.from("bundle")]),
  done: Promise.resolve(),
  release: async () => undefined,
});
