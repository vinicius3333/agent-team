# Research: agent-team (imported)

## Product

agent-team is a self-hosted orchestrator. It turns a plain-text product brief into a working web app or API by using a team of scoped AI agents (`README.md`, `package.json` "description"). Planning agents write the spec, architecture, branding, design system, and task plan. Worker agents then build the tasks in parallel, and a reviewer checks each one (`README.md`). Optional steps are approval gates, GitHub publishing (repo, issues, PRs, project board), QA with screenshots, and a live preview deploy. After that the app can take change requests, sprints, a backlog of findings, and "operate" insight agents (`README.md`, `src/ui/server.ts`, `docs/change-requests.md`, `docs/sprints.md`, `docs/operate.md`). You drive it from a CLI (`src/cli.ts`) and from a React web dashboard (`web/`) that `agent-team ui` serves.

## Users

- **Operators who host it themselves.** These are developers or small teams who run the dashboard on their own machine or server (`README.md` "Quick start", `docker-compose.yml`). They create a project from a brief with **New project**, or bring in an existing repo with **Import** (`web/src/pages/new-project.tsx`, `web/src/pages/import-project.tsx`). They pick the target, stack template, worker provider, and approval gates. They approve or request changes at gates, approve scope requests or drop tasks, raise budgets, resume runs, and read QA results, transcripts, and cost (`README.md` "Working with a run").
- **Lead-chat users.** They ask the project lead agent about a run in the **Lead** tab and apply the actions it suggests (`README.md`, `src/lead.ts`, POST `chat*` routes in `src/ui/server.ts`).
- **Maintainers of live apps.** They open change requests, approve or dismiss findings, start sprints and cleanups, run insight agents, and look at incidents (`src/ui/server.ts`, `web/src/pages/incidents.tsx`).
- **Admins.** They set up the login (`hash-password`, `session-secret`) or an auth proxy, the git identity, and notification channels (`README.md` "Access", `web/src/pages/settings.tsx`, `notifications.example.yaml`).
- A separate marketing site in `site/` goes to GitHub Pages for public visitors (`.github/workflows/pages.yml`).

## Stack

- **Language:** TypeScript on Node.js >= 22.18. Node runs the `.ts` files directly, with no build step for the server (`package.json` "engines", "start"; `tsconfig.json`). The only runtime dependency is `yaml` (`package.json`).
- **Server:** plain `node:http` with a hand-written router, no framework (`src/ui/server.ts`). Auth covers a scrypt password hash, an HMAC session cookie, lockouts, and a trusted-proxy user header (`src/ui/auth.ts`).
- **Database:** SQLite through the built-in `node:sqlite` (`DatabaseSync`) in WAL mode. Each project has its own file at `<runsDir>/<project>/.agent-team/state.db` (`src/store.ts`, `src/project.ts:172-177`). Project config lives in `pipeline.yaml` in each project (`pipeline.example.yaml`).
- **Dashboard:** React 19, Vite 8, React Router 8, Tailwind CSS 4, Radix UI / shadcn-style components, assistant-ui, react-markdown, and three.js through react-three-fiber (`web/package.json`, `web/components.json`). The built output in `web/dist` is served statically by the Node server (`src/ui/server.ts:1222`).
- **Marketing site:** React 19, Vite, Tailwind, and Remotion, deployed to GitHub Pages (`site/package.json`, `.github/workflows/pages.yml`).
- **Agent runners:** the `claude` CLI (Claude Code) and the `codex` CLI, plus `gh`, git, and Docker for sandboxes, QA screenshots, and previews (`README.md` "Requirements", `src/runners/`, `Dockerfile`).
- **Stack templates for generated apps:** `templates/fullstack`, `templates/node-api`, `templates/react-vite`.
- **Hosting:** a multi-stage `Dockerfile` on node:24-bookworm-slim. `docker-compose.yml` runs the `ui` and `doctor` services with host networking and the host Docker socket, and its comment names Dokploy as the production deploy. The default public host is `agent-team.137-131-153-58.sslip.io`, behind an edge Caddy. `docker/entrypoint.sh` loads secrets from `$HOME/.config/agent-team/doctor.env`.

## Routes

Login: the dashboard has no separate login URL. When a login is configured and the user is not authenticated, `App.tsx` shows `LoginPage` (`web/src/pages/login.tsx`) in place of every page, and every `/api` route except `/api/auth/*` returns 401 (`src/ui/server.ts:1214-1215`). When no login is configured on loopback (auth mode `none`), nothing needs a login (`src/ui/auth.ts:111`). `(signed in)` below means "requires login when a login is configured". Every POST also needs the header `x-agent-team: 1` and an allowed Origin (`src/ui/server.ts:995-996`).

Dashboard pages (`web/src/App.tsx`):
- `/` projects list (signed in)
- `/new` new project form (signed in)
- `/import` import an existing project (signed in)
- `/projects/:name/:phase?/:view?` project page: pipeline, tasks, events, QA, Lead chat, config, and more (signed in)
- `/incidents` incident list (signed in)
- `/incidents/:project/:id` incident detail (signed in)
- `/settings` settings (signed in)
- `*` not found (signed in)

API: GET (`src/ui/server.ts:1216-1343`):
- `GET /api/auth/session`
- `GET /api/defaults` (signed in)
- `GET /api/git-identity` (signed in)
- `GET /api/notifications` (signed in)
- `GET /api/templates` (signed in)
- `GET /api/incidents` (signed in)
- `GET /api/incidents/:project/:id` (signed in)
- `GET /api/projects` (signed in)
- `GET /api/projects/:name` (signed in)
- `GET /api/projects/:name/transcript/:file` (signed in)
- `GET /api/projects/:name/operate` (signed in)
- `GET /api/projects/:name/sprints` (signed in)
- `GET /api/projects/:name/findings?status=open|approved|dismissed|all` (signed in)
- `GET /api/projects/:name/markdown` (signed in)
- `GET /api/projects/:name/files` (signed in)
- `GET /api/projects/:name/chat-upload/:file` (signed in)
- `GET /api/projects/:name/raw?path=` (signed in)
- `GET /api/projects/:name/branding` and `/mockups` (signed in)
- `GET /api/projects/:name/branding/:file` and `/mockups/:file` (signed in)
- `GET /api/projects/:name/concepts` (signed in)
- `GET /api/projects/:name/concepts/:id/:file` (signed in)
- `GET /api/projects/:name/qa` (signed in)
- `GET /api/projects/:name/qa/:round/:file` (signed in)
- `GET /api/projects/:name/file?path=` (signed in)
- `GET /api/stream/:name`: Server-Sent Events that push the project detail every 2 s (signed in)
- Any other non-`/api` GET serves static files from `web/dist` (`serveStatic`)

API: POST (`src/ui/server.ts:994-1206`):
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/git-identity` (signed in)
- `POST /api/notifications/test` (signed in)
- `POST /api/projects`: create a project and start a run (signed in)
- `POST /api/projects/import` (signed in)
- `POST /api/projects/:name/chat-upload` (signed in)
- `POST /api/projects/:name/changes/:id/abandon` (signed in)
- `POST /api/projects/:name/changes/:id/merge` (signed in)
- `POST /api/projects/:name/findings/:id/approve` (signed in)
- `POST /api/projects/:name/findings/:id/dismiss` (signed in)
- `POST /api/projects/:name/findings`: add a backlog item (signed in)
- `POST /api/projects/:name/cleanup/start` (signed in)
- `POST /api/projects/:name/cleanup/dismiss` (signed in)
- `POST /api/projects/:name/sprints/start` (signed in)
- `POST /api/projects/:name/operate/run` (signed in)
- `POST /api/projects/:name/{changes|run|approve|feedback|retry|approve-suggestion|drop-task|approve-task-budget|raise-budget|chat|chat-session|chat-stop|chat-action|auto-approve-scope|gates|lead-settings|roles}` (signed in)

Other methods return 405. Requests whose Host header is not allowed return 403 (`AGENT_TEAM_UI_HOSTS`).

CLI subcommands (`src/cli.ts:323-368`): `hash-password`, `session-secret`, `templates`, `init`, `import`, `run`, `sprint`, `sprints`, `backlog`, `change`, `status`, `approve`, `retry`, `reset-cooldowns`, `deploy`, `operate`, `findings`, `undeploy`, `ui`, `doctor`, `notify-test`.

## Commands

- **Install:** `npm install`, then `npm run build:ui`, which runs `npm --prefix web ci && npm --prefix web run build` (`README.md`, `package.json`). The Dockerfile uses `npm ci --omit=dev` and `npm ci` in `web/`.
- **Test:** `npm test` (`node --test test/*.test.ts`). Also available: `npm run typecheck` (`tsc --noEmit`), `npm run test:templates` (`scripts/check-templates.ts`), and `npm --prefix web run lint` (oxlint) (`package.json`, `web/package.json`). CI covers only the `site/` lint and build (`.github/workflows/pages.yml`).
- **Build:** `npm run build:ui` for the dashboard. The server itself has no build step. The site uses `npm --prefix site run build:pages`.
- **Start:** `node src/cli.ts ui <runsDir> --port 4400`, with `CLAUDE_CODE_OAUTH_TOKEN` set in the environment (`README.md`). `npm start` runs `node src/cli.ts` with no arguments. Docker runs `node src/cli.ts ui /home/opc/agent-team-runs --port 4400` (`Dockerfile` CMD), and compose also runs `doctor`. Dashboard dev server: `npm --prefix web run dev` (Vite on its default port), which proxies `/api` to `AGENT_TEAM_API`, by default `http://127.0.0.1:4400` (`web/vite.config.ts`).
- **Port:** 4400 on host `127.0.0.1` by default (`src/cli.ts:40,364`). Compose binds to `172.17.0.1` (`docker-compose.yml`).

## Sources

- https://github.com/vinicius3333/agent-team (from `input.md`): read. It is a public MIT repo with about 200 commits and 0 stars or forks at fetch time. Its description matches the README: a self-hosted orchestrator for developers that turns briefs into apps through phases (spec, architecture, branding, design, plan, parallel build, QA, deploy), plus change requests, sprints, and monitoring. The page gave nothing that the repository does not already contain.
- `input.md` lists no other URLs: no live site and no separate docs site. The compose default host `agent-team.137-131-153-58.sslip.io` sits behind a login, and I did not fetch it.

## Open questions

- Is the Dokploy deployment at `agent-team.137-131-153-58.sslip.io` still the live production instance? What is the GitHub Pages URL of the `site/`? Neither appears in `input.md`.
- There is no CI for the server tests, the typecheck, or the dashboard build. Only `site/` is built in CI. Are `npm test` and `npm run typecheck` expected to pass on `main`?
- Real usage is unknown: how many operators use it, and whether anyone besides the author runs it.
- `npm start` with no subcommand probably prints the usage text. The real start command is `ui <runsDir>`, and I did not run it to confirm.
- I did not check how cost, budgets, and agent usage are billed or limited beyond the `budget.runUsd` setting in `pipeline.yaml`.
- The `docs/payments.md` and `docs/plans/` files suggest planned features. I did not check whether they are implemented.
