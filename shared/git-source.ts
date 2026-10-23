/**
 * Short display form of a git source: `owner/repo@ref` for GitHub, `host/owner/repo@ref` elsewhere.
 * Accepts ssh (`git@host:owner/repo.git`, `ssh://git@host/owner/repo`) and https (`https://host/owner/repo(.git)`) URLs.
 */
export function formatGitSource(url: string, ref?: string): string {
  const suffix = ref ? `@${ref}` : "";
  const parsed = parseRemote(url.trim());
  if (!parsed) return `${url.trim()}${suffix}`;
  const { host, path } = parsed;
  return `${host === "github.com" ? path : `${host}/${path}`}${suffix}`;
}

function parseRemote(url: string): { host: string; path: string } | null {
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(url);
  const standard = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url);
  const match = standard ?? scp;
  if (!match) return null;
  const path = match[2]!.replace(/\/+$/, "").replace(/\.git$/, "");
  return path ? { host: match[1]!.toLowerCase(), path } : null;
}
