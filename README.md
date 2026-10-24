# paseo-kubernetes-runtime

A Paseo plugin (`kubernetes-runtime`, shown as "Kubernetes Runtime") that runs a workspace in a Kubernetes pod:
a **workspace runtime** for Paseo. The agents in that workspace are the real Claude and Codex agents (same provider,
icon, catalog and pickers as local agents); only where their process runs changes. Pods are
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) `Sandbox` objects, so there is no
custom operator. It knows nothing about roles.

It needs a Paseo with workspace runtimes (the fork's `registerWorkspaceRuntime`). On a Paseo without them the plugin
loads, shows its screen, and says it does nothing.

## How it works

```
Paseo daemon                                   cluster (paseo-agents)
┌──────────────────────────────┐               ┌─────────────────────────────────┐
│ runtime "kubernetes"         │  kubectl apply│ Sandbox pka-<repo>-<slug>-<rand>│
│  prepare  (before a launch)  │──────────────▶│  └ pod + RWO volume             │
│  exec     (the provider cmd) │  kubectl exec │      /workspace   (HOME, CLIs)  │
│  beforeInput / onActivity    │◀─────────────▶│      <daemon path> = checkout   │
│  destroy  (workspace archived│   stdio       │      claude / codex  (real)     │
│  bridge: push, MCP tunnels   │               └─────────────────────────────────┘
└──────────────────────────────┘
```

- **One pod per workspace**, created when the first provider process is about to start (`prepare`), never when a
  workspace or a draft is merely opened. The Sandbox is labelled with the daemon id and the workspace id.
- **Same path.** Paths inside provider protocols (claude's session files, codex's thread cwd) are the daemon's, so the
  pod shows the checkout at the daemon's own absolute path: the volume is mounted at `/workspace` and its `checkout`
  subPath again at that path (a root init container makes it writable for the agent user).
- **Provider processes** run as `kubectl exec -i` with the exact command Paseo asks for. Their environment is the env
  delta Paseo passes (written to a short-lived env file in the pod, never on a command line), nothing from the daemon.
  `claude` and `codex` are installed on first use under `$HOME/.npm-global` (on the volume) if the image lacks them.
- **Seeding.** The daemon bundles the chosen ref from the project's own checkout (`git bundle`: the branch picker's
  branch, a branch-off base, or a pull request head, fetched first if missing) and streams it into the pod over
  `pods/exec` stdin; unpushed local commits come along. Nothing is cloned from GitHub in the pod.
- **No GitHub credential in the pod.** `git push` there goes to a local "outbox" repository whose `pre-receive`
  hook asks the plugin, over a bridge on the same `exec` channel, to push the new commits from the daemon with the
  daemon's own git credentials (branches only). `gh` and GitHub tools go through the GitHub Proxy plugin if it is
  installed and the agent is opted in (`PASEO_GITHUB_PROXY=on`, or its scope set to all).
- **Loopback MCP servers** (`http://127.0.0.1:<port>`: GitHub Proxy, MCP Proxy, Inbox, Leases, ...) found in the
  agent's MCP config at `prepare` are tunnelled by port, byte for byte, to the daemon's loopback over the same
  channel: URLs and headers stay unchanged, streams work, and only the named ports are reachable.
- **Credentials.** Only `CLAUDE_CODE_OAUTH_TOKEN`, from the Secret `paseo-agent-credentials`, by reference. Written from
  the screen (write-only: server-side apply on the Secret; removal is a merge patch through `kubectl proxy`).
- **Idle suspension.** When every agent of a workspace has been idle (no turn, no pending permission) for
  `podIdleMinutes` (default 30, 0 = never) the pod is deleted (`operatingMode: Suspended`); the volume, with the
  checkout and the agents' session state, stays. The next input (`beforeInput`) recreates the pod on the same volume with
  the current image, and the provider resumes its own session. A process that ends because the pod went away is
  reported as `runtime-lost`, so the agent run fails like any process exit and the next message relaunches it.
- **Archive.** Archiving the workspace (`destroy`) deletes the Sandbox and its volume claim. There is no expiry on a
  workspace's storage.
- **Orphans.** A reconciler (at start, then every 10 minutes) deletes the Sandbox and claim of any workspace Paseo no
  longer has (grace 5 minutes, every deletion logged); it only ever considers resources labelled with this daemon's id.
  Old `pka-` sandboxes with no daemon label are swept after 15 minutes unless the "Remove unlabelled leftovers"
  setting is off (turn it off where several daemons share a namespace). The screen shows "Last reconcile: N orphans
  removed".

## Settings

A sidebar item "Kubernetes Runtime" opens a screen: namespace and image; an Advanced section (kubectl context, node
selector, tolerated taint keys, workspace storage mode/size/class, idle suspension, unlabelled sweep); a Status section
(workspaces: running or suspended; last orphan cleanup); and a collapsible Credentials section with a write-only field
for `CLAUDE_CODE_OAUTH_TOKEN`. New workspace gets a **Pod** location (with the branch picker) once the token is set.

Settings and the credential flags that were kept under the plugin's old id `kube-agents` are copied over on first
start (originals backed up under `~/.paseo/backups/`, never overwritten, never deleted).

## Cluster requirements

See [docs/rbac-and-network.md](docs/rbac-and-network.md): Role for the daemon ServiceAccount, the credentials Secret,
storage and the default-deny NetworkPolicy.

## Limits (phase 1 of the workspace runtime)

- Files, Git and terminals in the Paseo UI still read the **daemon's** checkout, not the pod's. Claude's own history
  lives in the pod.
- Model and version discovery runs on the daemon, so claude and codex must exist there too.
- A provider that starts its processes inside the plugin process (opencode, pi, omp, plugin providers) is refused in a
  runtime workspace.
- No warm pool: the pod must mount the checkout at a path that is only known when the workspace is created.
- Uncommitted local changes are not copied (the seed is a commit).

## Development

```bash
npm ci
npm run typecheck && npm test
dagger call all        # same as CI: typecheck, test, build in a container (with git, the tests run real git)
```

`server/runtime-types.ts` mirrors the fork's runtime contract until the published plugin SDK carries it.
