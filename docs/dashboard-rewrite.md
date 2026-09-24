# Dashboard rewrite: spec

The dashboard moves from one hand-written `src/ui/index.html` to a React app, and it becomes writable: users create projects, approve gates, and send feedback to the agents from the browser. Everything still runs on the VPS.

## Visual reference

- Chosen style: "variation A" in `docs/brand/vision/light-a/` (01 new project, 02 build running, 03 approval gate, 04 shipped). Light theme by default, dark theme through `.dark`.
- Theme tokens: `docs/brand/tokens.css` (shadcn variables for Tailwind v4). Use them as is.
- Logo: `docs/brand/logo/symbol.svg` (favicon), `symbol-light.svg`, `symbol-dark.svg`. Ignore the logo drawn inside the mockup images; it is wrong.
- Icons: Lucide only.

## Stack

- `web/`: its own `package.json`. Vite, React 19, TypeScript, Tailwind CSS v4 (`@tailwindcss/vite`), shadcn/ui (new-york style, components copied into `web/src/components/ui`), `lucide-react`, `react-router` for routes. No other UI libraries. Markdown: `react-markdown` + `remark-gfm`.
- `npm run build` in `web/` writes to `web/dist/`. The root `package.json` gets `"build:ui": "npm --prefix web ci && npm --prefix web run build"`.
- Dev: Vite dev server proxies `/api` to `http://127.0.0.1:4400`.
- `web/dist/` and `web/node_modules/` are git-ignored.

## Server (`src/ui/server.ts`)

- Serves `web/dist/` as static files with an SPA fallback to `index.html` for any non-`/api` GET. Paths must stay inside `web/dist`. If `web/dist/index.html` is missing, answer 503 with "run npm run build:ui".
- All current GET endpoints stay the same.
- `src/ui/index.html` is deleted at the end.
- Stays bound to `127.0.0.1`. Access is through an SSH tunnel or `tailscale serve`.

### Write endpoints

All take and return JSON. Every POST must carry the header `x-agent-team: 1`; reject others with 403 (blocks cross-site form posts). Body limit 64 KB. Errors: `{ "error": "<plain sentence>" }` with 400, 404, or 409.

| Method and path | Body | Effect |
|---|---|---|
| `POST /api/projects` | `{ name, brief, target: "web"\|"api"\|"web+api", workerRunner: "claude"\|"codex", gates: PlanningPhase[], github: boolean, deploy: boolean, mockups: boolean }` | Validates the name (`^[a-z0-9][a-z0-9-]{1,40}$`, must not exist). Creates the project like `agent-team init` (shared function in `src/project.ts`), then writes the choices into its `pipeline.yaml` (keep comments where practical; `yaml` Document API). `workerRunner: "codex"` sets worker `{ runner: codex, model: gpt-5.5 }`. Starts a run. Returns `201 { name }`. |
| `POST /api/projects/:name/run` | `{}` | Starts a run if none is alive (`run.pid` meta + process check). 409 if one is running. |
| `POST /api/projects/:name/approve` | `{ phase }` | Same as `agent-team approve`, then starts a run. 409 if the phase is not `awaiting_approval`. |
| `POST /api/projects/:name/feedback` | `{ phase, message }` | "Request changes" on a gate. Phase must be `awaiting_approval`. Appends the message to `.agent-team/feedback/<phase>.md` with a timestamp, sets the phase to `pending`, logs a `gate` event, then starts a run. The pipeline re-runs that phase and adds the feedback to the agent prompt. |
| `POST /api/projects/:name/retry` | `{ taskId }` | Same as `agent-team retry`, then starts a run. |

Starting a run: spawn `process.execPath --disable-warning=ExperimentalWarning <repo>/src/cli.ts run <projectDir>` detached, stdio to `<runsDir>/<name>.log` (append), `unref()`. The child inherits the server's environment, so the server must be started with `CLAUDE_CODE_OAUTH_TOKEN` loaded.

### Pipeline change for feedback

`phasePrompt` in `src/pipeline.ts`: if `.agent-team/feedback/<phase>.md` exists, add "A human reviewed your last output and asked for these changes:" plus its content. The agent edits its existing outputs instead of starting over. Clear the file after the phase passes validation (rename to `<phase>.<timestamp>.done.md`).

`detail()` in the server adds `feedback: Record<phase, string>` (pending feedback text) so the UI can show it.

## Screens

Routes and what each shows. Parity with the old dashboard is required: every piece of data the old `index.html` shows must still be reachable.

1. **`/` Projects**: cards or table of projects (name, status, current phase, tasks done/total, cost, live URL badge, last activity). "New project" button. Empty state.
2. **`/new` New project** (mockup 01): name, brief textarea (character count), target segmented control, worker provider (Claude default, Codex), approval gate checkboxes (spec, architecture, mockups, design, plan; default spec and design), toggles for GitHub repo, deploy, mockups. "Start build" posts and navigates to the project. Right column: "Your agent team" list with Lucide icons and each role's configured model. Inline validation errors.
3. **`/projects/:name` Project** (mockup 02, 04): header with status badge; pipeline stepper (spec, architecture, mockups, design, plan, build, deploy) with states; stat cards (elapsed, tokens if available, cost with "n/a (codex)" when a runner reports none, tasks done/total); task table (id, title, worker runner/model, status, attempts, retry button when blocked); live events via `/api/stream/:name` (SSE); GitHub card (repo, PRs, board); deploy card (live URL, status) when deployed; "Resume run" button when stopped and not completed. Tabs or sections for: Docs (markdown list + viewer), Mockups (gallery with lightbox), Attempts (table; click opens transcript in a Sheet), Config (roles and models).
4. **Gate** (mockup 03): when a phase is `awaiting_approval`, the project page shows a prominent panel: the phase outputs (docs rendered from markdown, mockups gallery for the mockups/design phases), a feedback textarea, "Approve" and "Request changes" buttons. Show pending feedback if any.
5. **Details panel**: clicking a task, phase, or event opens a Sheet with its details and transcripts, like the old UI.

Layout: left sidebar (Projects, New project, Settings) collapsing to a sheet on mobile; 360px wide must work. Theme toggle (light, dark, system) stored in localStorage.

## Quality bar

- TypeScript strict, no `any` in the web app except for untyped API edges, typed in `web/src/api/types.ts`.
- Accessible: labels on every input, focus rings, keyboard reachable Sheet and Dialog, WCAG AA contrast (tokens already pass).
- Plain English UI copy: short, active voice.
- Match the repo style in `src/`: no semicolons, double quotes. The web app may use the Prettier defaults of shadcn, but keep it consistent within `web/`.
