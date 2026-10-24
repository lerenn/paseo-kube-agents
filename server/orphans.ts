import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KubeAgentsConfig } from "./config.js";
import type { Kube } from "./kube.js";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_LABEL, DAEMON_LABEL, MANAGED_BY, MANAGED_BY_LABEL, NATIVE_LABEL, sessionLabel, workspaceClaimName } from "./sandbox.js";

const execFileAsync = promisify(execFile);

export type AgentState = "alive" | "gone" | "unknown";

type Exec = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr?: string }>;

function errorCode(text: string | undefined): string | undefined {
  try {
    return (JSON.parse(text ?? "") as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

/**
 * Asks Paseo whether an agent still exists and is not archived. The CLI prints its JSON error to stderr
 * and exits non-zero when the agent is not found; anything but a clear answer is "unknown".
 */
export async function paseoAgentState(agentId: string, exec: Exec = execFileAsync as unknown as Exec): Promise<AgentState> {
  try {
    const { stdout } = await exec("paseo", ["agent", "inspect", agentId, "--json"], { timeout: 20_000 });
    const parsed = JSON.parse(stdout) as { Archived?: boolean; error?: { code?: string } };
    if (parsed.error) return parsed.error.code === "AGENT_NOT_FOUND" ? "gone" : "unknown";
    return parsed.Archived === true ? "gone" : "alive";
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    const code = errorCode(failed.stderr) ?? errorCode(failed.stdout);
    return code === "AGENT_NOT_FOUND" ? "gone" : "unknown";
  }
}

/**
 * Handles (hashed) of the provider sessions of Paseo's non-archived agents, read from the daemon's agent
 * store. Null when the store cannot be read: the sweep then stays off rather than guess.
 */
export function readLiveHandles(home = join(homedir(), ".paseo")): Set<string> | null {
  const handles = new Set<string>();
  try {
    for (const dir of readdirSync(join(home, "agents"))) {
      for (const file of readdirSync(join(home, "agents", dir))) {
        if (!file.endsWith(".json")) continue;
        try {
          const record = JSON.parse(readFileSync(join(home, "agents", dir, file), "utf8"));
          if (record.archivedAt) continue;
          const handle = record.persistence?.metadata?.pluginProviderPersistence?.data?.sessionId;
          if (typeof handle === "string") handles.add(sessionLabel(handle));
        } catch {
          // an unreadable record is skipped; the sweep only deletes what matches nothing
        }
      }
    }
    return handles;
  } catch {
    return null;
  }
}

export interface ReapStatus {
  /** ISO time of the last run. */
  lastRunAt?: string;
  /** Orphans deleted by the last run. */
  removed: number;
  /** Total deleted since the plugin started. */
  removedTotal: number;
  /** Plugin-looking resources with no daemon label: reported, never deleted. */
  unlabelled: string[];
  error?: string;
}

export interface ReaperDeps {
  getConfig(): Promise<KubeAgentsConfig>;
  kubeFor(config: KubeAgentsConfig): Kube;
  /** This daemon's id; without one the reaper does nothing. */
  daemonId?: string;
  agentState?: (agentId: string) => Promise<AgentState>;
  now?: () => number;
  /** Resources younger than this are left alone: the agent may not be registered yet. */
  graceMs?: number;
  /** Unlabelled leftovers get a longer grace period (default 15 minutes). */
  unlabelledGraceMs?: number;
  /**
   * Native session handles (hashed like the sandbox label) of this daemon's agents that are not archived;
   * null when that cannot be known, in which case nothing unlabelled is deleted.
   */
  liveHandles?: () => Promise<Set<string> | null>;
  /** Sandboxes this plugin is running right now, never swept. */
  activeSandboxes?: () => Set<string>;
  log?: (line: string) => void;
}

const created = (iso?: string) => (iso ? Date.parse(iso) : 0);

/**
 * Safety net for resources whose agent is gone (deleted, or archived while the plugin was stopped). It
 * only considers Sandboxes and claims labelled with THIS daemon's id and an agent id; anything labelled
 * for another daemon is never listed, and anything without a daemon label is reported, not deleted.
 */
export class OrphanReaper {
  private status: ReapStatus = { removed: 0, removedTotal: 0, unlabelled: [] };
  private timer?: NodeJS.Timeout;
  private running?: Promise<ReapStatus>;

  constructor(private readonly deps: ReaperDeps) {}

  current(): ReapStatus {
    return this.status;
  }

  start(intervalMs = 10 * 60_000, firstRunDelayMs = 20_000): void {
    this.stop();
    const run = () => void this.run().catch(() => undefined);
    const first = setTimeout(run, firstRunDelayMs) as unknown as NodeJS.Timeout;
    first.unref?.();
    this.timer = setInterval(run, intervalMs) as unknown as NodeJS.Timeout;
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  run(): Promise<ReapStatus> {
    this.running ??= this.reap().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async reap(): Promise<ReapStatus> {
    const { daemonId } = this.deps;
    const now = this.deps.now ?? Date.now;
    const log = this.deps.log ?? ((line: string) => console.log(line));
    const agentState = this.deps.agentState ?? paseoAgentState;
    const grace = this.deps.graceMs ?? 5 * 60_000;
    if (!daemonId) return (this.status = { ...this.status, error: "daemon id unknown: orphan cleanup is off" });
    try {
      const config = await this.deps.getConfig();
      const kube = this.deps.kubeFor(config);
      let removed = 0;

      const mine = await kube.listSandboxes(`${DAEMON_LABEL}=${daemonId}`);
      const known = new Map<string, AgentState>();
      for (const sandbox of mine) {
        const agent = sandbox.labels[AGENT_LABEL];
        if (!agent || now() - created(sandbox.createdAt) < grace) continue;
        if (!known.has(agent)) known.set(agent, await agentState(agent));
        if (known.get(agent) !== "gone") continue;
        log(`[kube-agents] orphan cleanup: deleting sandbox ${sandbox.name} (agent ${agent} is gone or archived)`);
        await kube.delete("sandbox", sandbox.name);
        await kube.delete("pvc", workspaceClaimName(sandbox.name)).catch(() => undefined);
        removed++;
      }

      // A claim outlives its sandbox only if garbage collection lags; delete it when its sandbox is gone.
      const live = new Set((await kube.listSandboxes(`${DAEMON_LABEL}=${daemonId}`)).map((s) => s.name));
      for (const claim of await kube.listClaims(`${DAEMON_LABEL}=${daemonId}`)) {
        const owner = claim.name.replace(/^workspace-/, "");
        if (live.has(owner) || now() - created(claim.createdAt) < grace) continue;
        log(`[kube-agents] orphan cleanup: deleting volume claim ${claim.name} (its sandbox is gone)`);
        await kube.delete("pvc", claim.name);
        removed++;
      }

      // Ours by name, but without a daemon label (made before labelling existed).
      const unlabelledGrace = this.deps.unlabelledGraceMs ?? 15 * 60_000;
      const handles = this.deps.liveHandles ? await this.deps.liveHandles() : null;
      const active = this.deps.activeSandboxes?.() ?? new Set<string>();
      const left: string[] = [];
      for (const sandbox of (await kube.listSandboxes(`${MANAGED_BY_LABEL}=${MANAGED_BY}`)).filter((s) => !s.labels[DAEMON_LABEL])) {
        const native = sandbox.labels[NATIVE_LABEL];
        const known = (native !== undefined && (handles?.has(native) ?? true)) || active.has(sandbox.name);
        const sweepable = config.sweepUnlabelled && handles !== null && sandbox.name.startsWith("pka-") && !known && now() - created(sandbox.createdAt) >= unlabelledGrace;
        if (!sweepable) {
          left.push(sandbox.name);
          continue;
        }
        log(`[kube-agents] orphan cleanup: deleting unlabelled sandbox ${sandbox.name} (matches no agent of this daemon)`);
        await kube.delete("sandbox", sandbox.name);
        await kube.delete("pvc", workspaceClaimName(sandbox.name)).catch(() => undefined);
        removed++;
      }
      if (config.sweepUnlabelled && handles !== null) {
        const sandboxNames = new Set((await kube.listSandboxes(`${MANAGED_BY_LABEL}=${MANAGED_BY}`)).map((s) => s.name));
        for (const claim of await kube.listClaims()) {
          if (claim.labels[DAEMON_LABEL] || !claim.name.startsWith("workspace-pka-")) continue;
          if (sandboxNames.has(claim.name.replace(/^workspace-/, "")) || now() - created(claim.createdAt) < unlabelledGrace) continue;
          log(`[kube-agents] orphan cleanup: deleting unlabelled volume claim ${claim.name} (its sandbox is gone)`);
          await kube.delete("pvc", claim.name);
          removed++;
        }
      }
      const unlabelled = left.sort();
      const unseen = unlabelled.filter((n) => !this.status.unlabelled.includes(n));
      if (unseen.length) log(`[kube-agents] orphan cleanup: ${unseen.length} sandbox(es) without a daemon label are left alone: ${unseen.join(", ")}`);

      this.status = {
        lastRunAt: new Date(now()).toISOString(),
        removed,
        removedTotal: this.status.removedTotal + removed,
        unlabelled,
      };
    } catch (error) {
      this.status = { ...this.status, lastRunAt: new Date(now()).toISOString(), error: (error as Error).message };
    }
    return this.status;
  }
}
