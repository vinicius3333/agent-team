# 0004: Docker Compose on one host, with host networking

Status: accepted (records the existing app)

## Context

agent-team drives the host's Docker daemon. It gives Docker host paths to mount into agent sandboxes and starts preview containers on host ports. So paths and ports must mean the same thing inside and outside its own container.

## Decision

- Build one image from the multi-stage `Dockerfile` (node:24-bookworm-slim, git, gh, Docker CLI, `claude`, `codex`, and the built dashboard).
- Run it with `docker-compose.yml` through Dokploy as two services, `ui` and `doctor`, with `network_mode: host`, `pid: host`, the Docker socket, and the operator's home folder mounted at the same path.
- Bind `ui` to the docker0 gateway and put an edge Caddy in front for TLS and the public host name.
- Load secrets from `$HOME/.config/agent-team/doctor.env` in `docker/entrypoint.sh`.
- Host the marketing site `site/` separately on GitHub Pages.

## Consequences

- The container has broad host access (Docker socket, host PIDs, home folder). Only trusted operators should reach the dashboard.
- One server only. Redeploying `ui` and `doctor` does not stop runs, because each run has its own container.
- The orchestrator preview through `deploy.json` runs only the dashboard, with no Docker, `gh`, or agent token, so it can show the UI but not build apps.
