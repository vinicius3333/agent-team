# Architecture: agent-team (imported)

This document describes the app as it is today. It plans no new features.

## Overview

agent-team is a self-hosted orchestrator. It turns a plain-text brief into a working web app or API with a team of scoped AI agents. It has one Node.js process that serves both a CLI and a web dashboard. The process spawns the `claude` and `codex` CLIs, git, `gh`, and Docker to plan, build, review, test, and deploy each project. State lives in one SQLite file per project, next to the project's files on local disk. A separate static marketing site in `site/` is built to GitHub Pages.

## Stack

- **Language:** TypeScript on Node.js >= 22.18. Node strips the types and runs `.ts` files directly, so the server has no build step.
- **Server:** plain `node:http` with a hand-written router in `src/ui/server.ts`. No framework, which keeps the only runtime dependency at `yaml`.
- **Database:** SQLite through the built-in `node:sqlite` (`DatabaseSync`, WAL mode). It needs no native build and no separate server.
- **Config:** `pipeline.yaml` in each project, parsed with `yaml`.
- **Dashboard (`web/`):** React 19, Vite 8, React Router, Tailwind CSS v4, shadcn/ui (Radix) components, Lucide icons, assistant-ui, react-markdown, and three.js through react-three-fiber. Vite builds it to `web/dist`, and the Node server serves those files.
- **Marketing site (`site/`):** React 19, Vite, Tailwind CSS, and Remotion. It is a static build that GitHub Pages hosts.
- **Agent runners:** the `claude` CLI (Claude Code) and the `codex` CLI, driven as child processes (`src/runners/`).
- **Tests:** the built-in `node:test` runner (`node --test test/*.test.ts`). It works offline and needs no extra packages. `tsc --noEmit` checks types. oxlint lints `web/` and `site/`.

## Components

- **CLI (`src/cli.ts`):** the entry point. It parses subcommands (`init`, `import`, `run`, `change`, `sprint`, `deploy`, `operate`, `ui`, `doctor`, `hash-password`, `session-secret`, and more) and calls the modules below.
- **Pipeline (`src/pipeline.ts`, `src/run.ts`, `src/tasks.ts`, `src/replan.ts`):** runs the phases (spec, architecture, branding, design, plan, build, QA, deploy) for one project. It runs worker tasks in parallel, calls the reviewer, and stops at approval gates.
- **Runners (`src/runners/`):** start `claude` or `codex` with a role prompt from `prompts/`, stream the transcript to disk, and report cost and status.
- **Harness (`src/harness/`):** gives each agent a workspace, runs it in a Docker sandbox when set up, controls network access, and classifies failures.
- **Store (`src/store.ts`):** opens the project's SQLite file and owns every table. All other modules read and write state through it.
- **Project files (`src/project.ts`, `src/config.ts`):** the project folder layout, `pipeline.yaml`, and the docs the agents write.
- **Change, sprint, and operate (`src/sprint.ts`, `src/operate/`, `src/feedback.ts`):** change requests on a finished app, sprints and cleanups, insight agents, health checks, and findings.
- **Lead chat (`src/lead.ts`, `src/lead-actions.ts`):** answers questions about a run and proposes actions that run only after the operator clicks them.
- **Doctor (`src/doctor.ts`, `src/incidents.ts`):** a long-running process that watches runs, diagnoses stops, tries repairs, and writes incidents.
- **Deploy and QA (`src/deploy.ts`, `src/qa.ts`, `src/smoke.ts`, `src/screenshots.ts`):** start the built app in a container, run smoke checks, take screenshots, and publish a preview.
- **GitHub (`src/github.ts`, `src/git.ts`, `src/commits.ts`):** repos, branches, PRs, issues, and the project board, through `git` and `gh`.
- **Notifications (`src/notify/`):** send run events to the channels in `notifications.yaml`.
- **Dashboard server (`src/ui/server.ts`, `src/ui/auth.ts`):** the HTTP API under `/api`, a Server-Sent Events stream per project, and static files from `web/dist`. It calls the same modules as the CLI.
- **Dashboard client (`web/src/`):** a single-page app. It talks to the server only through `web/src/api/client.ts` (JSON over `fetch`, plus `EventSource` for `/api/stream/:name`).
- **Marketing site (`site/src/`):** static pages with no server calls.

## Auth

- The dashboard has no user accounts. It has one shared password or a trusted auth proxy (`src/ui/auth.ts`).
- Password login: `AGENT_TEAM_UI_PASSWORD_HASH` holds a scrypt hash made with `agent-team hash-password` (at least 12 characters). A good login sets an HMAC-signed, HttpOnly, `SameSite=Strict` session cookie signed with `AGENT_TEAM_UI_SESSION_SECRET` (random at startup if unset). Sessions last `AGENT_TEAM_UI_SESSION_HOURS`.
- The cookie is `Secure` only when the request came over HTTPS: a `*.ts.net` host, or a trusted proxy that sends `X-Forwarded-Proto: https`. So login works over plain http in smoke checks and QA. The app does not read `APP_URL` for this.
- Proxy login: `AGENT_TEAM_UI_TRUSTED_PROXIES` (IPs or CIDRs) plus `AGENT_TEAM_UI_PROXY_USER_HEADER`.
- Lockouts: 5 wrong passwords from one address in 15 minutes lock that address for 15 minutes. 30 failures from any address lock all logins for 15 minutes.
- With no login set, the server listens only on loopback. It refuses a non-loopback bind unless `--insecure-no-auth` is passed.
- Every POST needs the header `x-agent-team: 1` and an allowed Origin. Every request needs an allowed Host: loopback, `*.ts.net`, or a name in `AGENT_TEAM_UI_HOSTS`.
- **Demo login:** the app has no users, so it cannot seed a demo user. `deploy.json` instead hashes `DEMO_PASSWORD` into `AGENT_TEAM_UI_PASSWORD_HASH` at startup. `DEMO_EMAIL` is not used. The password is piped to `hash-password` and never logged. `DEMO_PASSWORD` must be at least 12 characters, or the hash step fails and the server refuses to start on `0.0.0.0`.
- **Public URL:** the dashboard makes no absolute links of its own. `deploy.json` adds the host name from `APP_URL` to `AGENT_TEAM_UI_HOSTS` so requests to the public host are not refused. Any other unknown host still gets 403.
- **Checkers:** smoke checks, QA, and the import baseline (`captureApp` in `src/screenshots.ts`) pass `APP_URL` set to the URL their browser uses, as deploy does. The login checker fills an email field only when the form has one, so it can log in to the password-only card with `DEMO_PASSWORD` (ADR 0005).

## Data model

Each project has its own SQLite file at `<runsDir>/<project>/.agent-team/state.db` (`src/store.ts`). There is no shared database across projects. The project list is the list of folders in `<runsDir>`.

- **phases:** `name` (PK), `status`, `updated_at`. One row per pipeline phase.
- **phase_history:** `change_id`, `name`, `status`, `updated_at`. Phase states saved when a change run starts.
- **tasks:** `id` (PK, from `tasks.json`), `status`, `attempts`, `last_failure`.
- **attempts:** `id`, `subject` (task or phase), `role`, `runner`, `model`, `status`, `failure_class`, `cost_usd`, `duration_ms`, `transcript_path`, `created_at`. One row per agent run. Run cost is the sum of `cost_usd`.
- **reviews:** `id`, `task_id` → tasks, `attempt`, `verdict`, `flagged_files` (JSON), `file_hashes` (JSON), `created_at`.
- **events:** `id`, `at`, `type`, `message`. The activity feed.
- **meta:** `key` (PK), `value`. Run-level flags, such as stop reason and pending decisions.
- **runner_health:** `runner` (PK), `cooldown_until`, `reason`.
- **chat_messages:** `id`, `at`, `author`, `body`, `actions` (JSON), `details` (JSON), `session`. Lead chat.
- **changes:** `id` (PK), `request`, `status`, `branch`, `base_commit`, `pr_url`, `created_at`, `finished_at`.
- **findings:** `id`, `source`, `severity`, `title`, `evidence`, `proposal`, `status` (open, approved, dismissed), `change_id` → changes, `fingerprint`, `created_at`, `updated_at`.
- **sprints:** `number` (PK), `status`, `goal`, `score`, `change_id` → changes, `cost_at_start`, `cost_usd`, `note`, `started_at`, `finished_at`.
- **insight_runs:** `id`, `agent`, `started_at`, `finished_at`, `status`, `summary`, `findings`.
- **health_checks:** `at`, `ok`, `status_code`, `latency_ms`, `error`.
- **metrics:** `at`, `key`, `value`.

Files on disk hold the rest: `pipeline.yaml`, the agents' docs under `docs/`, `tasks.json`, transcripts, QA screenshots, branding, mockups, chat uploads, and incidents.

## Directory layout

```
package.json, package-lock.json   server manifest (shared; foundation only)
tsconfig.json                     server type check
src/
  cli.ts                          CLI entry point (shared)
  ui/server.ts                    HTTP router and API (shared)
  ui/auth.ts                      login, sessions, lockouts
  store.ts                        SQLite schema and queries (shared)
  pipeline.ts, run.ts, tasks.ts   pipeline and task loop
  runners/                        claude and codex runners
  harness/                        sandboxes, workspaces, network
  operate/                        insight agents, findings, health
  notify/                         notification channels
  *.ts                            one module per feature (lead, doctor, qa, deploy, sprint, import, ...)
prompts/                          one system prompt per agent role
templates/                        stack templates for generated apps
knowledge/                        seed lessons
test/                             node:test files, one per feature (*.test.ts)
scripts/                          maintenance scripts
web/                              dashboard (own package.json and lockfile)
  src/App.tsx, main.tsx           router and entry (shared)
  src/api/                        API client, hooks, types (shared)
  src/pages/                      one file per route
  src/components/ui/              shadcn/ui primitives
  src/components/<feature>/       project, operate, office, incidents
  src/lib/, src/hooks/            helpers
site/                             marketing site (own package.json)
docker/                           entrypoint, QA and proxy images
Dockerfile, docker-compose.yml    production image and services
docs/                             design docs, plans, ADRs
evals/                            eval briefs and results
```

## Commands

- install: npm ci && npm run build:ui
- test: npm test
- dev: node --disable-warning=ExperimentalWarning src/cli.ts ui .agent-team-runs --port 4400

For dashboard work, also run `npm --prefix web run dev`. Vite proxies `/api` to `AGENT_TEAM_API` (default `http://127.0.0.1:4400`). Type check with `npm run typecheck`.

## Deployment

- **Production today:** `docker-compose.yml` on one server, deployed with Dokploy. It builds the multi-stage `Dockerfile` (node:24-bookworm-slim with git, gh, the Docker CLI, `claude`, and `codex`). It runs two services from the same image: `ui` (the dashboard on port 4400) and `doctor`. Both use host networking, the host PID namespace, the host Docker socket, and the operator's home folder. So paths and ports mean the same inside and outside the container. Each run gets its own container from `agent-team:latest`.
- `ui` binds to the docker0 gateway (`172.17.0.1`), and an edge Caddy proxies the public host to it. `docker/entrypoint.sh` loads secrets (login hash, session secret, `CLAUDE_CODE_OAUTH_TOKEN`, and others) from `$HOME/.config/agent-team/doctor.env`.
- Logs go to stdout. State lives on the host disk under `<home>/agent-team-runs`, so the process is not stateless. This is a deliberate choice for a single-server tool (see ADR 0002).
- **Orchestrator preview (`deploy.json`):** installs with `npm ci && npm run build:ui` and starts the dashboard on `0.0.0.0:$PORT` with a runs folder at `.agent-team-runs`. The start command hashes `DEMO_PASSWORD` into the login and allows the `APP_URL` host. The preview can show the dashboard and log in. Starting real runs also needs `claude`, `gh`, Docker, and an agent token, which the preview does not provide.
- **Marketing site:** `.github/workflows/pages.yml` lints and builds `site/` and publishes it to GitHub Pages.
