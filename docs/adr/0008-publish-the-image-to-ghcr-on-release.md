# 0008: Publish the Docker image to ghcr.io on each release

## Context

Installing agent-team takes several steps today (clone, npm, CLIs, login hash). C003 (#8) asks for a one-command start with `docker run`. The spec kept CI out of scope, and the only workflow builds the marketing site.

## Decision

- Add `.github/workflows/release-image.yml`. It runs when a release is published, builds the repo's `Dockerfile` for `linux/amd64` and `linux/arm64`, and pushes `ghcr.io/vinicius3333/agent-team` with the release tag and `latest`.
- It logs in with the built-in `GITHUB_TOKEN` (`packages: write`). No other secret.
- It runs no tests and no typecheck. Other CI stays out of scope.
- The site's `#install` section starts with a `docker run` of that image.

## Consequences

- A release is enough to ship an image; nobody builds it by hand.
- The image is public, so it must never hold a token. Credentials come in at run time through environment variables and volumes.
- A broken `Dockerfile` shows up only when a release fails to build. Tests still run on the host, not in CI.
