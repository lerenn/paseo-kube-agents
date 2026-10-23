# Fat default image for kube-agents pods. Contains NO credentials: tokens arrive at runtime
# through the paseo-agent-credentials Secret (envFrom). Named templates (go, node, infra)
# build FROM this image and add toolchains.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client curl ca-certificates jq ripgrep python3 python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/gh.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/gh.list \
 && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Agent CLIs and their ACP adapters (the pod speaks ACP over stdio via `kubectl exec`).
RUN npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp @openai/codex

RUN useradd -m -u 1000 agent && mkdir -p /workspace && chown agent /workspace
USER agent
WORKDIR /workspace
CMD ["sleep", "infinity"]
