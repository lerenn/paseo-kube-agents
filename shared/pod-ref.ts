import type { RuntimeOptions } from "./runtime-options.js";

export type PickedRef = NonNullable<RuntimeOptions["ref"]>;

/** The runtime options for a new workspace: the project directory, Paseo's slug and the branch picker's choice. */
export function runtimeOptions(cwd: string, slug: string, ref: PickedRef | null): RuntimeOptions {
  return { cwd, slug, ref };
}
