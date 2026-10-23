# paseo-kube-agents

A Paseo provider plugin (`lerenn/kube-agents`) that runs each agent in its own Kubernetes pod, using
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) (`Sandbox` CRD) instead of a custom operator.
It knows nothing about roles; it only maps "an agent session" to "a pod".

Status: proof of concept, one agent per pod, developed against a fake cluster. Not yet run against the lab cluster.

## How it works

```
Paseo daemon                                   cluster (paseo-agents)
┌──────────────────────────────┐               ┌───────────────────────────────┐
│ provider "kube-agents"       │  kubectl apply│ Sandbox pka-<session>-<rand>  │
│  connectKube()               │──────────────▶│  └ pod (default/go/node image)│
│   session.open               │  kubectl exec │      git clone <repo>@<branch>│
│   ├ apply Sandbox, wait Ready│──────────────▶│      claude-agent-acp  (ACP)  │
│   ├ git clone in pod         │◀── ndjson ───▶│                               │
│   └ SDK ACP runtime ◀────────┤   over stdio  └───────────────────────────────┘
│  session.close → delete      │
└──────────────────────────────┘
```

- **Event relay**: no custom protocol. The pod runs an [ACP](https://agentclientprotocol.com) adapter
  (`claude-agent-acp`, `codex-acp`, ...) and the daemon talks JSON-RPC over `kubectl exec -i` stdio.
  The SDK's `runAcpProvider` turns ACP updates into the same provider events (`timeline.item`,
  `session.turn`, permissions) the built-in providers emit. agent-sandbox ships the same pattern in `examples/agentclientprotocol`.
  The SDK connector takes no arguments and is also used for capability probes, so kube-agents owns
  the pod lifecycle itself (`server/connection.ts`) and hands the SDK a connector bound to the session's pod.
- **Workspace**: the daemon reads `origin` and the current branch of the session's `cwd`, and the pod runs
  `git clone --branch <b>`. The agent sees committed and pushed state only; local uncommitted changes
  do not travel. Paseo is told the session cwd is still the daemon-local path.
- **Credentials**: never in images or manifests. Pods mount the Secret `paseo-agent-credentials` with
  `envFrom` (`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`). Clones use `GH_TOKEN` via a git credential helper
  (ssh remotes are rewritten to https). Pods have no ServiceAccount token, run non-root, and have a hard
  `lifecycle.shutdownTime` (default 8h) as a backstop for leaked pods.
- **Storage and restarts**: `/workspace` (the clone, plus `HOME` so the agent's session state) is a plain
  ReadWriteOnce PVC from the Sandbox's `volumeClaimTemplates` (default 10Gi, default StorageClass; settable, or
  `ephemeral` for an emptyDir). When the pod is lost (eviction, node loss, delete) the Sandbox controller
  recreates it, the plugin waits for it (showing why if it cannot be scheduled), reuses the clone and reopens the
  agent's session from its saved handle. A turn that was running is marked failed. Uncommitted work survives; an
  ephemeral workspace loses it. Archiving deletes the Sandbox and its claim.
- **Cleanup**: `session.close`, connection close, a failed start, and the shutdown backstop all delete the Sandbox.

## Settings UI

A sidebar item "Kube Agents" opens a screen (host-scoped plugin settings) with: namespace and default image
(Cluster), an Advanced section (kubectl context, node selector, tolerated taint keys, agent command), a compact
template list (default plus named ones; expand a row to edit its image, "Add template" adds one), and write-only
credential fields. Sidebar position is controlled by the host (Settings > Sidebar lets the user reorder).

- **Templates**: one fat default image (`image/Dockerfile`: claude, codex, git, gh, node, python, build tools) plus
  optional named templates. The only per-agent setting is env `PASEO_KUBE_TEMPLATE` (session env, then daemon env,
  else `default`). An unknown name fails the session start and lists the known templates.
- **Warm pools**: stored per template (off by default, size 1, idle timeout 900s) but hidden in the UI and not acted on yet; the
  `SandboxClaim`/`SandboxWarmPool` path comes after the end-to-end run. Pods are rendered as `Sandbox` directly for now.
- **Credentials**: password fields for `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`.
  Values are write-only: the plugin server-side-applies them into the Secret `paseo-agent-credentials` (value sent on stdin,
  not argv) and keeps only a local set / not set flag in `~/.paseo/kube-agents-credentials.json` (mode 0600).
  The daemon has no `get` on the Secret, so the flag reflects what this plugin wrote.
- **Inert until selected**: registering the provider makes no cluster call; pods are created only when an agent is
  created with provider `kube-agents`.

## Cluster requirements

See [docs/rbac-and-network.md](docs/rbac-and-network.md): Role for the daemon ServiceAccount, the credentials Secret,
and the default-deny NetworkPolicy.

## Limits

Single catalog (no model list yet), no session listing/persistence, no `unarchive`, uncommitted local changes are not
visible in the pod, agent env from Paseo is not forwarded (secrets come from the Secret only), and `kubectl` must be on the daemon's PATH.

## Development

```bash
npm ci
npm run typecheck && npm test
dagger call all        # same as CI: typecheck, test, build in a container
```

CI is `.github/workflows/ci.yml` running the Dagger module in `.dagger/` (same layout as agents-roles).
