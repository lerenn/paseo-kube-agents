// The workspace runtime contract of the Paseo fork (workspace runtimes, phase 1), copied here because the
// published plugin SDK does not carry it yet. Delete this file and import from "@getpaseo/plugin/server" once it does.
import type { Readable, Writable } from "node:stream";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

/**
 * A workspace runtime owns where a workspace's agent processes execute. The verbs mirror the
 * workspace runtime contract proposed upstream in getpaseo/paseo#3360 (`describe`, `create`,
 * `inspect`, `exec`, `signal`, `pause`, `resume`, `destroy`, `reconcile`), so a runtime written
 * here can move to that contract. A plugin registers the runtime in-process instead of as a
 * daemon-config executable. `prepare`, `beforeInput` and `onActivity` are extensions for
 * runtimes that suspend and resume their sandbox.
 */

/** Opaque, trusted JSON the workspace's creator handed to the runtime. Paseo never reads it. */
export type WorkspaceRuntimeOptions = Record<string, unknown>;

export interface WorkspaceRuntimeCapabilities {
  /** `exec` supports piped stdin/stdout/stderr. Required for agent processes. */
  pipes: boolean;
  /** `exec` supports a pseudo-terminal. Reserved for terminals (a later phase). */
  pty: boolean;
}

export interface WorkspaceRuntimeDescription {
  /** 1 until the contract changes. */
  protocolVersion: number;
  capabilities: WorkspaceRuntimeCapabilities;
}

export interface WorkspaceRuntimeWorkspaceRequest {
  workspaceId: string;
  options?: WorkspaceRuntimeOptions;
}

export interface WorkspaceRuntimeStatus {
  state: "running" | "suspended" | "resuming" | "error" | "absent";
  message?: string;
}

export type WorkspaceRuntimeProcessPurpose = "session" | "probe";

export interface WorkspaceRuntimeExecRequest extends WorkspaceRuntimeWorkspaceRequest {
  agentId?: string;
  /** Provider id that asked for the process, e.g. "claude". */
  provider?: string;
  /**
   * "session" drives an agent. "probe" only reads provider metadata (models, version) and must
   * not create or resume a sandbox.
   */
  purpose: WorkspaceRuntimeProcessPurpose;
  /** Executable and arguments, exactly as the provider asked to run them. The image must contain it. */
  argv: [string, ...string[]];
  /** Working directory on the daemon. Map it to the runtime's own path. */
  cwd?: string;
  /** Complete environment the process must receive. Never extend it with the daemon's environment. */
  env: Record<string, string>;
}

export interface WorkspaceRuntimePrepareRequest extends WorkspaceRuntimeExecRequest {
  /** MCP servers of the agent's final configuration, so the runtime can tunnel loopback ports. */
  mcpServers?: Record<string, JsonValue>;
}

export interface WorkspaceRuntimeInputRequest extends WorkspaceRuntimeWorkspaceRequest {
  agentId: string;
}

export type WorkspaceRuntimeActivity =
  | "turn_started"
  | "turn_ended"
  | "permission_requested"
  | "permission_resolved"
  | "input";

export interface WorkspaceRuntimeActivityEvent extends WorkspaceRuntimeInputRequest {
  activity: WorkspaceRuntimeActivity;
}

/**
 * Why an exec ended. `runtime-lost` means the sandbox went away (evicted, suspended) rather than
 * the process finishing; Paseo then reconciles the runtime and the next input relaunches.
 */
export type WorkspaceRuntimeExitReason = "exited" | "runtime-lost";

export interface WorkspaceRuntimeExit {
  code: number | null;
  signal: string | null;
  reason: WorkspaceRuntimeExitReason;
  /** Shown to the user when the process did not exit cleanly. */
  message?: string;
}

export interface WorkspaceRuntimeProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exit: Promise<WorkspaceRuntimeExit>;
  signal(signal: string): void | Promise<void>;
}

export interface WorkspaceRuntimeContext {
  /** Shows progress or a problem to the user ("pod pending", "resuming"). */
  notice(message: string, level?: "info" | "warning" | "error"): void;
}

export interface WorkspaceRuntimeRegistration {
  /** Lowercase letters, digits, ".", "_" and "-". Workspaces reference the runtime by this id. */
  id: string;
  label: string;
  /** SVG file inside the plugin directory. Apps show it wherever a workspace shows its location. */
  icon?: string;
  describe(): WorkspaceRuntimeDescription | Promise<WorkspaceRuntimeDescription>;
  /** Materialize the workspace. Idempotent. */
  create?(
    request: WorkspaceRuntimeWorkspaceRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  inspect?(
    request: WorkspaceRuntimeWorkspaceRequest,
    context: WorkspaceRuntimeContext,
  ): WorkspaceRuntimeStatus | Promise<WorkspaceRuntimeStatus>;
  pause?(
    request: WorkspaceRuntimeWorkspaceRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  resume?(
    request: WorkspaceRuntimeWorkspaceRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  /** Delete the workspace's sandbox. Runs when the workspace is archived, never on disconnect. */
  destroy?(
    request: WorkspaceRuntimeWorkspaceRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  /** Re-adopt sandboxes after a daemon restart or a `runtime-lost` exit. */
  reconcile?(context: WorkspaceRuntimeContext): void | Promise<void>;
  /**
   * Runs before every session launch with the final command, environment and MCP servers.
   * Idempotent: a resume prepares again.
   */
  prepare?(
    request: WorkspaceRuntimePrepareRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  /** Awaited before Paseo delivers a prompt or permission answer, so a suspended sandbox resumes first. */
  beforeInput?(
    request: WorkspaceRuntimeInputRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  onActivity?(event: WorkspaceRuntimeActivityEvent): void;
  /**
   * Start the process. May be slow and may report progress through `context.notice`. Abort the
   * start through `signal`. Execs of one workspace are serialized.
   */
  exec(
    request: WorkspaceRuntimeExecRequest,
    context: WorkspaceRuntimeContext & { signal: AbortSignal },
  ): WorkspaceRuntimeProcess | Promise<WorkspaceRuntimeProcess>;
}
