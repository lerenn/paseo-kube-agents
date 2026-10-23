Kube Agents runs each Paseo agent in its own Kubernetes pod instead of on the daemon machine. Pick the "Kube Agents" provider when creating an agent, and the agent works on a fresh clone of your repository's current branch inside an isolated pod. The pod is deleted when the agent is closed.

## Setup

The daemon needs `kubectl` on its PATH with access to a cluster that runs kubernetes-sigs/agent-sandbox, a namespace for the pods, and a Secret named `paseo-agent-credentials` holding tokens such as `GH_TOKEN` and `ANTHROPIC_API_KEY`. Settings live in the Kube Agents screen in the sidebar: kubectl context, namespace, pod images, named pod templates, warm pool options and write-only credential fields. Set the environment variable `PASEO_KUBE_TEMPLATE` on an agent to choose a template; otherwise the default is used. Requires Paseo 0.11.2 or later.

## Limits

The pod clones the branch from `origin`, so only pushed commits are visible to the agent. Uncommitted local changes are not copied. Session history is not listed or restored after the pod is gone.
