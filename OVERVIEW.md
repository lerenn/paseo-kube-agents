Kube Agents runs each Paseo agent in its own Kubernetes pod instead of on the daemon machine. Pick the "Kube Agents" provider when creating an agent, and the agent works on a copy of your repository's checkout, at the branch you pick, inside an isolated pod. The pod is deleted when the agent is closed.

## Setup

The daemon needs `kubectl` on its PATH with access to a cluster that runs kubernetes-sigs/agent-sandbox, a namespace for the pods, and a Secret named `paseo-agent-credentials` holding `CLAUDE_CODE_OAUTH_TOKEN`. Settings live in the Kube Agents screen in the sidebar: kubectl context, namespace, pod image and write-only credential fields. Requires Paseo 0.11.2 or later.

## Limits

The pod is seeded from a git bundle of the project checkout on the daemon, so committed work (pushed or not) is visible to the agent and uncommitted local changes are not copied. Pushes from the pod are made by the daemon with its own git credentials; the pod holds no GitHub token. Session history is not listed or restored after the pod is gone.
