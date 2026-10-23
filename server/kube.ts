import { spawn } from "node:child_process";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";

export interface PodInfo {
  uid: string;
  ready: boolean;
  /** Being deleted: not usable even if it still reports Ready. */
  terminating: boolean;
  phase?: string;
  /** Why the pod is not running yet, in a form fit to show a user (scheduling, volume, image pull). */
  problem?: string;
}

export function parsePodInfo(pod: any): PodInfo {
  const conditions: any[] = pod?.status?.conditions ?? [];
  const cond = (type: string) => conditions.find((c) => c.type === type);
  const unscheduled = cond("PodScheduled")?.status === "False" ? cond("PodScheduled") : undefined;
  const waiting = (pod?.status?.containerStatuses ?? [])
    .map((c: any) => c.state?.waiting)
    .find((w: any) => w?.reason && w.reason !== "ContainerCreating" && w.reason !== "PodInitializing");
  const problem = unscheduled
    ? `Pod cannot be scheduled: ${unscheduled.message ?? unscheduled.reason}`
    : waiting
      ? `Container waiting: ${waiting.reason}${waiting.message ? ` (${waiting.message})` : ""}`
      : undefined;
  return {
    uid: pod?.metadata?.uid ?? "",
    ready: cond("Ready")?.status === "True",
    terminating: Boolean(pod?.metadata?.deletionTimestamp),
    phase: pod?.status?.phase,
    ...(problem ? { problem } : {}),
  };
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The only cluster surface kube-agents needs; tests substitute a fake. */
export interface Kube {
  apply(manifest: Record<string, unknown>): Promise<void>;
  /** Current state of a pod, or null when it does not exist (yet). */
  podInfo(name: string): Promise<PodInfo | null>;
  exec(pod: string, argv: string[]): Promise<ExecResult>;
  /** Long-lived stdio JSON-RPC (ndjson) stream to a process inside the pod. */
  execStream(pod: string, argv: string[]): AcpStream;
  delete(kind: string, name: string): Promise<void>;
  readonly namespace: string;
  /**
   * Server-side-applies one Secret key, with a field manager per key so writing one key never drops
   * another. Needs only `patch` on the Secret. The manifest travels on stdin, never on argv.
   */
  applySecretKey(secret: string, key: string, manifest: string): Promise<void>;
}

export interface KubectlOptions {
  context?: string;
  namespace: string;
  binary?: string;
}

function run(binary: string, args: string[], stdin?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

export function ndjsonStream(
  child: Pick<ReturnType<typeof spawn>, "stdin" | "stdout" | "kill">,
): AcpStream {
  let buffer = "";
  // The consumer cancelling the reader kills the child, whose stdout then ends: closing or
  // enqueuing after that throws, and an uncaught throw here takes down the whole plugin process.
  let done = false;
  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (error) controller.error(error);
        else controller.close();
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line || done) continue;
          try {
            controller.enqueue(JSON.parse(line) as AcpStreamMessage);
          } catch {
            // Non-JSON output (banners, warnings) is not part of the protocol.
          }
        }
      });
      child.stdout!.on("end", () => finish());
      child.stdout!.on("error", (e) => finish(e));
    },
    cancel() {
      done = true;
      child.kill();
    },
  });
  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      return new Promise((resolve, reject) => {
        child.stdin!.write(`${JSON.stringify(message)}\n`, (e) => (e ? reject(e) : resolve()));
      });
    },
    close() {
      child.stdin!.end();
    },
    abort() {
      child.kill();
    },
  });
  return { readable, writable };
}

export class Kubectl implements Kube {
  readonly namespace: string;
  private readonly binary: string;
  private readonly base: string[];

  constructor(options: KubectlOptions) {
    this.namespace = options.namespace;
    this.binary = options.binary ?? "kubectl";
    this.base = [...(options.context ? ["--context", options.context] : []), "-n", options.namespace];
  }

  protected async ok(args: string[], stdin?: string): Promise<ExecResult> {
    const result = await run(this.binary, [...this.base, ...args], stdin);
    if (result.code !== 0) {
      throw new Error(`kubectl ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
    }
    return result;
  }

  async apply(manifest: Record<string, unknown>): Promise<void> {
    await this.ok(["apply", "-f", "-"], JSON.stringify(manifest));
  }

  async podInfo(name: string): Promise<PodInfo | null> {
    const result = await this.ok(["get", "pod", name, "--ignore-not-found", "-o", "json"]);
    return result.stdout.trim() ? parsePodInfo(JSON.parse(result.stdout)) : null;
  }

  exec(pod: string, argv: string[]): Promise<ExecResult> {
    return run(this.binary, [...this.base, "exec", pod, "--", ...argv]);
  }

  execStream(pod: string, argv: string[]): AcpStream {
    const child = spawn(this.binary, [...this.base, "exec", "-i", pod, "--", ...argv], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    return ndjsonStream(child);
  }

  async applySecretKey(_secret: string, key: string, manifest: string): Promise<void> {
    await this.ok(
      ["apply", "--server-side", `--field-manager=paseo-kube-agents-${key.toLowerCase()}`, "--force-conflicts", "-f", "-"],
      manifest,
    );
  }

  async delete(kind: string, name: string): Promise<void> {
    await this.ok(["delete", kind, name, "--ignore-not-found", "--wait=false"]);
  }
}
