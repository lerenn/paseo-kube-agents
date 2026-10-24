Kubernetes Runtime runs a Paseo workspace in a Kubernetes pod instead of on the daemon machine. Pick the "Pod" location when creating a workspace, and the agents in it are the same Claude and Codex agents as anywhere else, with the same pickers; only their process runs in the pod. The workspace is a copy of your project's checkout, at the same path, from the branch you pick. The pod is created when an agent first starts, suspended after the agents have been idle for a while (the files are kept), resumed by the next message, and deleted with its storage when the workspace is archived.

## Setup

The daemon needs `kubectl` on its PATH with access to a cluster that runs kubernetes-sigs/agent-sandbox, a namespace for the pods, and a Secret named `paseo-agent-credentials` holding `CLAUDE_CODE_OAUTH_TOKEN`. Settings live in the Kubernetes Runtime screen in the sidebar: kubectl context, namespace, pod image, storage, idle suspension and write-only credential fields. Requires a Paseo with workspace runtimes.

## Limits

The pod is seeded from a git bundle of the project checkout on the daemon, so committed work (pushed or not) is visible to the agent and uncommitted local changes are not copied. Pushes from the pod are made by the daemon with its own git credentials; the pod holds no GitHub token. The Files, Git and terminal panels still show the daemon's checkout, not the pod's.
