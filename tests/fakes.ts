import type { AcpConnector, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { ExecResult, Kube } from "../server/kube.js";

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
  }
  async waitReady(kind: string, name: string) {
    this.calls.push(`wait:${kind}/${name}`);
    if (this.waitError) throw this.waitError;
  }
  async exec(pod: string, argv: string[]) {
    this.calls.push("exec");
    this.execs.push({ pod, argv });
    return this.execResult;
  }
  execStream(pod: string, argv: string[]) {
    this.streams.push({ pod, argv });
    return {
      readable: new ReadableStream<AcpStreamMessage>(),
      writable: new WritableStream<AcpStreamMessage>(),
    };
  }
  patches: { name: string; patch: string }[] = [];
  patchError?: Error;
  async patchSecret(name: string, patch: string) {
    if (this.patchError) throw this.patchError;
    this.patches.push({ name, patch });
  }
  async delete(kind: string, name: string) {
    this.calls.push(`delete:${kind}/${name}`);
  }
}

/** Stands in for the ACP runtime: records inputs, replays a scripted event stream. */
export class FakeAcp {
  inputs: ProviderInput[] = [];
  listeners = new Set<(e: ProviderEvent) => void>();
  closed = false;
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
            this.emit({ type: "session.opened", sessionId: input.sessionId, capabilities: [], restoration: "core", cwd: input.config.cwd });
            this.emit({ type: "session.ready", sessionId: input.sessionId });
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
        },
      }),
    };
  };

  emit(event: ProviderEvent) {
    for (const l of this.listeners) l(event);
  }
}
