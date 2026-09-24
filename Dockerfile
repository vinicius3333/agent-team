# agent-team itself: the dashboard and the doctor. docker-compose.yml runs it on the host's
# network, PID namespace and home directory, so it behaves like a process started on the host.

FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim
ARG TARGETARCH
ARG DOCKER_VERSION=27.5.1
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

# git and gh for publishing, ssh for git remotes, the Docker CLI to drive the host's daemon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client gnupg \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*
RUN architecture=$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64) \
  && curl -fsSL "https://download.docker.com/linux/static/stable/${architecture}/docker-${DOCKER_VERSION}.tgz" \
  | tar -xz -C /usr/local/bin --strip-components=1 docker/docker
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
  && npm cache clean --force

# The image's uid 1000 user is renamed to match the host user whose home directory is mounted.
RUN usermod -l opc -d /home/opc -m node && groupmod -n opc node

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
COPY --from=web /app/web/dist ./web/dist

USER opc
ENV HOME=/home/opc
CMD ["node", "--disable-warning=ExperimentalWarning", "src/cli.ts", "ui", "/home/opc/agent-team-runs", "--port", "4400"]
