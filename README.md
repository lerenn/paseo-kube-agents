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
│  connectKube()               │──────────────▶│  └ pod + RWO volume           │
│   session.open               │  kubectl exec │      workspace from a bundle  │
│   ├ apply Sandbox, wait Ready│──────────────▶│      claude-agent-acp  (ACP)  │
│   ├ bundle the ref, seed pod │◀── ndjson ───▶│      bridge: push, tunnels    │
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
- **Workspace**: seeded from the project's checkout on the daemon (below). Paseo is told the session cwd is still the daemon-local path.
- **No GitHub access in the pod**: nothing is cloned from GitHub there and no GitHub token is a credential of the pod.
  - *Seeding*: the daemon bundles the chosen ref from the project's own checkout (`git bundle`; fetching it first if the
    daemon lacks it; a branch, a branch-off base or a pull request head) and streams it into the pod over `pods/exec`
    stdin. The pod builds its workspace from the bundle, so unpushed local commits come along.
  - *Pushing*: `git push` in the pod goes to a local "outbox" repo whose `pre-receive` hook asks the plugin, over a
    bridge on the same `kubectl exec` channel, to push the new commits from the daemon with the daemon's own git
    credentials. The agent sees an ordinary git result, including the remote's rejection. Only branch pushes are
    accepted (no deletes, tags or other refs).
  - *`gh` and GitHub tools*: pod agents are opted in to the GitHub Proxy plugin (`PASEO_GITHUB_PROXY=on`). Any loopback
    URL in the agent's MCP config (`http://127.0.0.1:<port>`: GitHub Proxy, MCP Proxy, Agents Inbox, Leases, ...) is
    tunnelled by port over the same channel, byte for byte, so URLs and bearer headers stay unchanged and streaming
    works. Only the ports the session's config names are reachable, only on the daemon's loopback. Without the GitHub
    Proxy plugin, `gh` explains that no GitHub access is configured. Plugins stay independent: nothing is imported.
- **Credentials**: only `CLAUDE_CODE_OAUTH_TOKEN`, read from the Secret `paseo-agent-credentials` by reference
  (never inline, never the whole Secret). Pods have no ServiceAccount token, run non-root, and have a hard
  `shutdownTime` (default 8h) as a backstop for leaked pods.
- **Opening a session is free**: Paseo opens many sessions that never run (drafts, feature previews, every agent
  again after a daemon restart). The plugin answers the open from the provider catalog and creates the pod (or
  resumes the suspended one) only when the first message arrives. Paseo is given a stable handle minted here; the
  agent process's own session handle stays on the Sandbox, and the reopen waits until that session is really open
  before delivering anything.
- **Orphans**: every Sandbox and volume claim is labelled with the owning daemon id (`paseo.sh/daemon`, from
  `~/.paseo/server-id`) and the Paseo agent id (`paseo.sh/agent`). A reconciler runs at plugin start and every 10
  minutes, asks Paseo (`paseo agent inspect`) about each labelled agent, and deletes the Sandbox and claim of any
  agent that no longer exists or is archived (grace 5 minutes, every deletion logged). It never lists another
  daemon's resources; resources without a daemon label (made before labelling) are swept only when they match no
  live agent and are 15 minutes old (setting "Remove unlabelled leftovers", on by default, turn it off where daemons
  share a namespace). An agent in use has no expiry: its storage goes only on archive, or here. The screen shows
  "Last reconcile: N orphans removed".
- **Idle suspension**: an agent idle (no turn running, nothing waiting on a permission) for `podIdleMinutes`
  (default 30, 0 = never) has its pod deleted with the Sandbox's `operatingMode: Suspended`; its volume, and the
  agent's saved session handle, stay. Any input (a prompt, a steer from another plugin or agent) recreates the pod on
  the same volume with the current image and settings, reopens the session from its handle, and then delivers the
  message; inputs that arrive meanwhile queue behind the resume. If the pod cannot be scheduled (the volume is bound
  to a zone with no capacity), the screen and the agent show why, the sandbox is released again, and the next input
  retries. Closing the plugin suspends pods instead of deleting them; the agent's
  sandbox is found again by a per-session label when Paseo reopens the session. Only archiving (or the reconciler, for a gone agent) deletes the volume.
- **Warm pool** (off by default): `warmPool.size` pre-started Sandboxes (same image, settings and volume as a real
  agent) so a new agent skips scheduling and volume binding. A new pod agent claims a ready one (relabelled to its
  session) and is then seeded, tunnelled and credentialed as usual; the pool refills behind it. Pods built for old
  settings (image, resources, placement, storage) are recycled. After `warmPool.idleMinutes` (default 60) with no
  pod agent requested the pool scales to 0 so burst nodes can go; the next request wakes it and is itself cold.
  Disabling the pool deletes it. Managed by the plugin: the agent-sandbox warm pool CRDs are not installed, and the
  pool needs no verbs beyond the Sandbox ones the daemon already has. Warm pods are only for new agents: a resumed
  agent needs its own volume, which is bound to its own zone. The Status section of the screen shows the pool
  (active, or asleep since...) and each pod agent (running or suspended).
- **Storage and restarts**: `/workspace` (the clone, plus `HOME` so the agent's session state) is a plain
  ReadWriteOnce PVC from the Sandbox's `volumeClaimTemplates` (default 10Gi, default StorageClass; settable, or
  `ephemeral` for an emptyDir). When the pod is lost (eviction, node loss, delete) the Sandbox controller
  recreates it, the plugin waits for it (showing why if it cannot be scheduled), reuses the clone and reopens the
  agent's session from its saved handle. A turn that was running is marked failed. Uncommitted work survives; an
  ephemeral workspace loses it. Archiving deletes the Sandbox and its claim.
- **Cleanup**: `session.close`, connection close, a failed start, and the shutdown backstop all delete the Sandbox.

## Settings UI

A sidebar item "Kube Agents" opens a screen (host-scoped plugin settings) with: namespace and image
(Cluster), an Advanced section (kubectl context, node selector, tolerated taint keys, agent command) and a
collapsible Credentials section with write-only fields. Sidebar position is controlled by the host (Settings > Sidebar lets the user reorder).

- **One pod configuration**: namespace, image (`image/Dockerfile` is the fat default: claude, codex, git, gh, node,
  python, build tools), placement and resources. Named templates and warm pools were removed for now; settings saved
  with templates are migrated (the old `default` template's values become the flat settings). Pods are rendered as
  `Sandbox` objects directly.
- **Credentials**: a write-only field for `CLAUDE_CODE_OAUTH_TOKEN`.
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
