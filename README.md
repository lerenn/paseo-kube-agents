# paseo-kube-agents

A Paseo provider plugin (`lerenn/kube-agents`) that runs each agent in its own Kubernetes pod, using
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) (`Sandbox` CRD) instead of a custom operator.
It knows nothing about roles; it only maps "an agent session" to "a pod".

Status: proof of concept, one agent per pod, developed against a fake cluster. Not yet run against the lab cluster.

## How it works

```
Paseo daemon                                   cluster (paseo-agent-sandboxes)
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
  `envFrom` (`GH_TOKEN`, `ANTHROPIC_API_KEY`, ...). Clones use `GH_TOKEN` via a git credential helper
  (ssh remotes are rewritten to https). Pods have no ServiceAccount token, run non-root, and have a hard
  `lifecycle.shutdownTime` (default 8h) as a backstop for leaked pods.
- **Cleanup**: `session.close`, connection close, a failed start, and the shutdown backstop all delete the Sandbox.

## Templates

One fat default image (`image/Dockerfile`: claude, codex, git, gh, node, python, build tools) plus optional named
templates in `~/.paseo/kube-agents.json` (path override: env `PASEO_KUBE_CONFIG`):

```json
{
  "context": "anyshift-personal-lab",
  "namespace": "paseo-agent-sandboxes",
  "defaultImage": "ghcr.io/lerenn/paseo-kube-agents-default:latest",
  "agentCommand": ["claude-agent-acp"],
  "templates": {
    "default": { "nodeSelector": { "karpenter.sh/nodepool": "burst" } },
    "go": { "image": "ghcr.io/lerenn/paseo-kube-agents-go:latest", "resources": { "requests": { "cpu": "2", "memory": "4Gi" } } }
  }
}
```

The only per-agent setting is env `PASEO_KUBE_TEMPLATE` (session env, then daemon env, else `default`).
An unknown name fails the session start and lists the known templates.

PoC choice: pods are rendered as `Sandbox` directly. Mapping a template to a `SandboxTemplate` +
`SandboxWarmPool` (claims, near-instant start) is the follow-up; in `v1beta1` a `SandboxClaim` references a warm pool.

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

CI is `.github/workflows/ci.yml` running the Dagger module in `.dagger/` (same layout as agent-roles).
