import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** What the Kube Agents screen shows: the workspaces this plugin runs pods for. */
export const kubeStatus = defineRpc({
  name: "kube.status",
  input: z.object({}),
  output: z.object({
    reaper: z.object({
      lastRunAt: z.string().optional(),
      removed: z.number(),
      removedTotal: z.number(),
      unlabelled: z.array(z.string()),
      error: z.string().optional(),
    }),
    pods: z.array(
      z.object({
        workspaceId: z.string(),
        sandbox: z.string(),
        state: z.enum(["running", "suspended", "resuming"]),
        /** ISO time the pod entered this state. */
        since: z.string(),
      }),
    ),
  }),
});
