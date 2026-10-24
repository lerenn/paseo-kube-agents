export type PodState = "running" | "suspended" | "resuming";

export interface PodEntry {
  workspaceId: string;
  sandbox: string;
  state: PodState;
  /** When the pod entered this state (ms since epoch). */
  since: number;
}

/** What the plugin currently runs, for the status shown in the Kube Agents screen. */
export class PodRegistry {
  private readonly entries = new Map<string, PodEntry>();

  set(workspaceId: string, sandbox: string, state: PodState, now = Date.now()): void {
    const current = this.entries.get(workspaceId);
    this.entries.set(workspaceId, { workspaceId, sandbox, state, since: current?.state === state ? current.since : now });
  }

  delete(workspaceId: string): void {
    this.entries.delete(workspaceId);
  }

  list(): PodEntry[] {
    return [...this.entries.values()].sort((a, b) => a.since - b.since);
  }
}
