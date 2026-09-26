Read docs/progress.md first. It lists what earlier tasks built.

agent-team is a self-hosted orchestrator: a Node.js CLI plus a React dashboard that turn a brief into an app with AI agents. See `docs/architecture.md` for the full picture.

## Commands

- install: npm ci && npm run build:ui
- test: npm test
- dev: node --disable-warning=ExperimentalWarning src/cli.ts ui .agent-team-runs --port 4400

Also useful: `npm run typecheck` (server types), `npm --prefix web run dev` (dashboard with hot reload, proxies `/api` to port 4400), `npm --prefix web run lint` (oxlint), `npm run test:templates` (stack templates).

## Directory layout

- `src/cli.ts`: CLI entry point. Shared file.
- `src/ui/server.ts`: HTTP router and every `/api` route. Shared file.
- `src/ui/auth.ts`: password login, sessions, lockouts, trusted proxy.
- `src/ui/hosts.ts`: the allowed host list. `deploy.json` builds it with `agent-team preview-hosts`; never hard-code a host name.
- `src/store.ts`: SQLite schema and all queries. Shared file.
- `src/*.ts`: one module per feature (pipeline, run, tasks, lead, doctor, qa, deploy, sprint, import, ...).
- `src/runners/`, `src/harness/`, `src/operate/`, `src/notify/`: agent runners, sandboxes, insight agents, notifications.
- `prompts/`: one system prompt per agent role.
- `templates/`: stack templates for generated apps.
- `test/`: `node:test` files, one per feature, named `<feature>.test.ts`.
- `web/`: the dashboard, with its own `package.json` and lockfile.
  - `web/src/App.tsx`, `web/src/main.tsx`: router and entry. Shared files.
  - `web/src/api/`: the only place that calls the server (`client.ts`, `hooks.ts`, `types.ts`).
  - `web/src/pages/`: one file per route.
  - `web/src/components/ui/`: shadcn/ui primitives. `web/src/components/<feature>/`: feature components.
- `site/`: the marketing site on GitHub Pages. Separate package.
- `docker/`, `Dockerfile`, `docker-compose.yml`: production image and services. `.github/workflows/release-image.yml` pushes the image to ghcr.io on each release.
- `.env.example`: names of the secrets the preview reads, with a comment each. Never values.
- `contracts/openapi.yaml`: the dashboard HTTP API.

## Conventions

- TypeScript ES modules, run by Node directly. Use only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties. Import local files with the `.ts` extension.
- Style: two-space indent, double quotes, no semicolons. Match the file you edit.
- Names: files in kebab-case; functions and variables in camelCase; React components in PascalCase.
- Server code uses only Node built-ins plus `yaml`. Do not add runtime dependencies without an ADR.
- State goes through `src/store.ts`. Large content goes in files in the project folder.
- Tests: add or update `test/<feature>.test.ts` with `node:test` and `node:assert`. Tests run offline and must not call real agents, GitHub, or Docker; use temp folders and fakes. They must pass in a clean `node:24-bookworm` container with no git identity, so tests that commit set `user.name` and `user.email` themselves.
- Errors: throw `new Error("plain sentence.")` with a message the operator can act on. API routes answer `{ "error": "..." }` with a 4xx status for bad input.
- Every POST needs the `x-agent-team: 1` header; the web client adds it. Do not weaken the Host, Origin, or auth checks.
- Config comes from environment variables (`AGENT_TEAM_UI_*`, `CLAUDE_CODE_OAUTH_TOKEN`) and `pipeline.yaml`. Never commit secrets or log passwords. A key named in `pipeline.yaml` is an env var name (`apiKeyEnv`), never the key.
- Code that calls `gh` or `docker` takes the call as an injected function, so tests pass a fake.
- Log to stdout with a short `[area]` prefix.
- Dashboard UI: Tailwind CSS v4, shadcn/ui, Lucide icons. It must work at 360px wide.
- Write docs and UI text in plain English: short sentences, active voice.
