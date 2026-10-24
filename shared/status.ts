import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** What the Kube Agents screen shows: the warm pool, and the pod agents this plugin runs. */
export const kubeStatus = defineRpc({
  name: "kube.status",
  input: z.object({}),
  output: z.object({
    pool: z.object({
      state: z.enum(["off", "active", "asleep"]),
      size: z.number(),
      ready: z.number(),
      starting: z.number(),
      asleepSince: z.string().optional(),
    }),
    pods: z.array(
      z.object({
        sessionId: z.string(),
        sandbox: z.string(),
        state: z.enum(["running", "suspended", "resuming"]),
        /** ISO time the pod entered this state. */
        since: z.string(),
      }),
    ),
  }),
});
