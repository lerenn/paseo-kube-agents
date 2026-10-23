import type { Kube, PodInfo } from "./kube.js";

export interface WaitOptions {
  timeoutSeconds: number;
  pollMs?: number;
  /** Called when the reason the pod is not ready changes (for example it cannot be scheduled yet). */
  onProblem?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the sandbox's pod exists, is Ready and is not terminating. A timeout names the last
 * known problem (unschedulable, volume bound to another zone, image pull) instead of hanging silently.
 */
export async function waitPodReady(kube: Kube, name: string, options: WaitOptions): Promise<PodInfo> {
  const { timeoutSeconds, pollMs = 2000, onProblem, sleep = realSleep, now = Date.now } = options;
  const deadline = now() + timeoutSeconds * 1000;
  let lastProblem: string | undefined;
  for (;;) {
    const info = await kube.podInfo(name).catch(() => null);
    if (info?.ready && !info.terminating) return info;
    const problem = info?.terminating ? "Pod is being replaced" : info?.problem;
    if (problem && problem !== lastProblem) {
      lastProblem = problem;
      onProblem?.(problem);
    }
    if (now() >= deadline) {
      throw new Error(
        `Pod ${name} was not ready after ${timeoutSeconds}s${lastProblem ? `: ${lastProblem}` : info ? "" : " (it does not exist)"}`,
      );
    }
    await sleep(pollMs);
  }
}
