import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Env vars the UI may write into the credentials Secret. Values are write-only. */
export const CREDENTIAL_KEYS = [
  "GH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export const CredentialKeySchema = z.enum(CREDENTIAL_KEYS);
export type CredentialKey = z.infer<typeof CredentialKeySchema>;

/** Whether each key was written from this plugin. The Secret itself is never read. */
export const credentialsStatus = defineRpc({
  name: "kube.credentials.status",
  input: z.object({}),
  output: z.object({ set: z.record(z.string(), z.boolean()) }),
});

export const credentialsSet = defineRpc({
  name: "kube.credentials.set",
  input: z.object({ key: CredentialKeySchema, value: z.string().min(1).max(8192) }),
  output: z.object({ set: z.record(z.string(), z.boolean()) }),
});
