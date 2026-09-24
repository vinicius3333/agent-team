FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
  && npm cache clean --force

# node:22 ships a "node" user with uid 1000; rename it so HOME and name match what the executor mounts.
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node

LABEL org.opencontainers.image.title="agent-team-runner" \
  agent-team.claude-code-version="${CLAUDE_CODE_VERSION}" \
  agent-team.codex-version="${CODEX_VERSION}"

ENV HOME=/home/agent
USER agent
WORKDIR /workspace
