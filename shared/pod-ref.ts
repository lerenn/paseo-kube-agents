/** Env that carries the branch picker's choice (and the auto name) from the client to the provider. */
export const REF_ENV_KEYS = {
  action: "PASEO_KUBE_ACTION",
  ref: "PASEO_KUBE_REF",
  pullRequest: "PASEO_KUBE_PR",
  slug: "PASEO_KUBE_SLUG",
} as const;

export interface PickedRef {
  action: "branch-off" | "checkout";
  refName?: string;
  changeRequest?: { forge: string; number: number; projectPath?: string };
}

export function refEnv(ref: PickedRef | null, slug: string): Record<string, string> {
  const env: Record<string, string> = { [REF_ENV_KEYS.slug]: slug };
  if (!ref) return env;
  env[REF_ENV_KEYS.action] = ref.action;
  if (ref.refName) env[REF_ENV_KEYS.ref] = ref.refName;
  if (ref.changeRequest) env[REF_ENV_KEYS.pullRequest] = String(ref.changeRequest.number);
  return env;
}
