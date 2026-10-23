# Cluster requirements (lab: `anyshift-personal-lab`, namespace `paseo-agents`)

What kube-agents needs from the cluster. Nothing here is created by the plugin.

## 1. agent-sandbox controller

Install kubernetes-sigs/agent-sandbox, controller named `paseo-agents-controller` (core `agents.x-k8s.io` CRDs; the PoC uses only `Sandbox`).
The default `sandboxApiVersion` is `agents.x-k8s.io/v1beta1`; confirm with
`kubectl get crd sandboxes.agents.x-k8s.io -o jsonpath='{.spec.versions[*].name}'`.

## 2. Namespace

`paseo-agents`, on the Karpenter burst pool. Pods get the pool through the template's
`nodeSelector`/`tolerations` in kube-agents config (the lab agent should tell us the labels/taints).
Suggested labels: `pod-security.kubernetes.io/enforce: baseline` (pods run non-root, no SA token).

## 3. RBAC for the daemon ServiceAccount (Role + RoleBinding in `paseo-agents`)

```yaml
rules:
  - apiGroups: ["agents.x-k8s.io"]
    resources: ["sandboxes"]
    verbs: ["get", "list", "watch", "create", "patch", "delete"]   # kubectl apply/wait/delete
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]                                               # clone + agent stdio
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]                                                  # debugging only
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["paseo-agent-credentials"]
    verbs: ["patch", "update"]                                      # write-only credentials from the plugin UI
```

The daemon never gets `get`/`list`/`watch`/`create` on secrets, so it cannot read credentials back; the pod
reads the Secret through `envFrom` via the kubelet. The plugin sets a key with a server-side apply sent on stdin
(`kubectl apply --server-side --field-manager=paseo-kube-agents-<key> --force-conflicts -f -` with a Secret manifest carrying
only that key). It must not use `kubectl patch`, which GETs the object first and would be refused without `get`.
Server-side apply needs only `patch`; the lab creates the Secret placeholder, so `create` is not needed. One field manager
per key keeps writes to different keys independent.
Because values can't be read, the UI's "set / not set" comes from plugin-local state, not the cluster. No ClusterRole needed. Future (not in the PoC):
`sandboxclaims`/`sandboxwarmpools` + `sandboxtemplates` (extensions.agents.x-k8s.io) get/list/create/delete.

## 4. Credentials Secret

`paseo-agent-credentials` in the namespace, created as an empty placeholder by the lab (not in git, not in images); values are written from the plugin UI. Keys become
env vars in every agent pod:

| key | use |
| --- | --- |
| `GH_TOKEN` | `git clone` (credential helper) and `gh`; a fine-grained token scoped to the repos agents may touch |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | claude |
| `OPENAI_API_KEY` | codex (optional) |

The Secret is `optional` in the pod spec so the pod still starts without it.

## 5. NetworkPolicy (default-deny, then allow)

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: agent-pods, namespace: paseo-agents}
spec:
  podSelector: {matchLabels: {app.kubernetes.io/managed-by: paseo-kube-agents}}
  policyTypes: [Ingress, Egress]
  ingress: []        # exec goes API server -> kubelet, not over the pod network
  egress:
    - to: [{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}}]
      ports: [{port: 53, protocol: UDP}, {port: 53, protocol: TCP}]
    - to: [{ipBlock: {cidr: 0.0.0.0/0, except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.169.254/32]}}]
      ports: [{port: 443, protocol: TCP}]   # github.com, api.anthropic.com, api.openai.com, npm, Go proxy
```

Adjust the `except` list to the cluster's pod/service/VPC CIDRs. SSH (22) is not needed: clones use https.
