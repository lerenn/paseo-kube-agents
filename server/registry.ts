export type PodState = "running" | "suspended" | "resuming";

export interface PodEntry {
  sessionId: string;
  sandbox: string;
  state: PodState;
  /** When the pod entered this state (ms since epoch). */
  since: number;
}

/** What the plugin currently runs, for the status shown in the Kube Agents screen. */
export class PodRegistry {
  private readonly entries = new Map<string, PodEntry>();

  set(sessionId: string, sandbox: string, state: PodState, now = Date.now()): void {
    const current = this.entries.get(sessionId);
    this.entries.set(sessionId, { sessionId, sandbox, state, since: current?.state === state ? current.since : now });
  }

  delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  list(): PodEntry[] {
    return [...this.entries.values()].sort((a, b) => a.since - b.since);
  }
}
