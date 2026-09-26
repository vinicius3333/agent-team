# Project hierarchy and the Operate phase: spec

> The Operate agents are now built-in [routines](routines.md). Their schedules live in the `routines` block, and `operate.schedule` below is the older format, still read for old projects.

Today the project page has ten flat tabs, and a project's story ends at deploy. This spec does two things:

1. **Hierarchy.** The app sidebar becomes a project tree: project → phase (Build, Launch, Operate, System) → view. The flat tab bar goes away. The sidebar can collapse to an icon rail. On mobile it opens as a sheet.
2. **Operate.** After deploy, three insight agents (monitoring, PostHog analytics, and competitor research) write **findings**. The Operate views show how the app runs and list the findings as a backlog. A person approves a finding, and it becomes a change request through the existing change flow (`docs/change-requests.md`).

The mockups in `docs/mockups/project-hierarchy/` are the visual target. `v1/` and `v2/` are older rounds; use the top-level PNGs.

Rules for all work: match the repo style (no semicolons, double quotes, erasable TS, `.ts` imports); add tests with stubs (no real network, Docker, or agent calls in tests); keep `npx tsc --noEmit`, `npm test`, and `npm run build:ui` passing; log every automatic decision as an event; projects with no Operate config behave exactly as today. Each commit is atomic and uses `<type>(<scope>): <subject>`. Never add AI attribution to commits.

## Decisions

| Question | Decision |
|---|---|
| How findings become work | Agents write findings. A person approves one, and it opens a change request. Nothing changes the app without approval. |
| Data sources in v1 | Monitoring (data we already have), PostHog (HTTP API), competitor research (web search). No plugin framework. |
| PostHog instrumentation | Stack templates ship `posthog-js`, off unless a public key is set. |
| "Suggested next steps" | The open findings, ranked by severity, then by date. No extra LLM call to rank them. |
| Scheduling | The doctor loop runs due agents. The dashboard also has a **Run now** button per agent. |

## Group A: backend

### A1. Store

Add to `src/store.ts`:

- `findings` table: `id INTEGER PK`, `source TEXT` (`monitoring` | `analytics` | `research`), `severity TEXT` (`high` | `medium` | `low`), `title TEXT`, `evidence TEXT`, `proposal TEXT`, `status TEXT` (`open` | `approved` | `dismissed`), `change_id TEXT NULL`, `fingerprint TEXT`, `created_at`, `updated_at`.
  - `addFinding` skips a finding when an `open` finding with the same `fingerprint` exists. It updates that finding's evidence and `updated_at` instead. Fingerprint: `source` + normalized title (lowercase, collapsed spaces).
  - `listFindings({ status? })`, `setFindingStatus(id, status, changeId?)`.
- `health_checks` table: `at`, `ok INTEGER`, `status_code INTEGER NULL`, `latency_ms INTEGER NULL`, `error TEXT NULL`. Keep the last 14 days. Prune on insert.
- `insight_runs` table: `id`, `agent`, `started_at`, `finished_at`, `status` (`running` | `done` | `failed`), `summary TEXT`, `findings INTEGER`. The UI reads the last run per agent from it.
- `metrics` table for PostHog numbers: `at`, `key`, `value REAL`. Keys: `wau`, `signups`, `signup_conversion`, plus `funnel.<step>` rows from the latest run.

### A2. Config

Add an optional `operate` block to `pipeline.yaml` (`src/config.ts`, and document it in `pipeline.example.yaml`):

```yaml
operate:
  enabled: true              # default true once deployed; false turns off every agent
  healthPath: /              # probed on the live URL
  schedule:                  # hours between runs; 0 turns an agent off
    monitoring: 24
    analytics: 24
    research: 168
  posthog:
    host: https://us.posthog.com
    projectId: "12345"
    publicKey: phc_xxx        # passed to the app as POSTHOG_KEY and VITE_POSTHOG_KEY
    apiKeyEnv: POSTHOG_API_KEY  # name of the env var with the personal API key; never the key itself
  competitors:
    - https://example.com
```

Each agent has its own role in `roles` (`monitor`, `analyst`, `researcher`), with Claude Opus 5.5 (`claude-opus-5-5`) as the default. Add the roles to `roles` and `defaultRoles`.

### A3. Health probe

`src/operate/health.ts`: `probe(url, path)` does a `GET` with a 10 s timeout and returns `{ ok, statusCode, latencyMs, error }`. `ok` means a 2xx or 3xx status. The doctor tick probes every live project (`deploy.url` set and deploy approved) at most every 5 minutes and stores the result. When 3 probes in a row fail, log `operate` event `health: down (<reason>)`. On the first success after that, log `health: recovered`.

`healthSummary(store)`: uptime % over 7 days, p95 latency over 24 h, last check time, and current state (`up` | `down` | `unknown`).

### A4. Insight agents

`src/operate/agents.ts` holds one runner function, `runInsightAgent({ projectDir, agent, runAgent? })`. It is modelled on `askLead` in `src/lead.ts`: host executor, read-only tools, `recordAttempt` with `subject: "insight-<agent>"`, a budget of $1 per call, and a 10-minute timeout. The server gathers the data. The agent only reasons over it, and writes JSON:

```json
{ "summary": "one paragraph", "findings": [ { "severity": "high", "title": "...", "evidence": "...", "proposal": "..." } ] }
```

Parse it with `extractJsonObject`. Keep at most 5 findings per run. Drop findings with missing fields and log them. The prompts go in `prompts/monitor.md`, `prompts/analyst.md`, and `prompts/researcher.md`. Each prompt says: evidence must quote numbers or sources; the proposal must be one change small enough for one change request; write in English.

| Agent | Input the server gathers | Tools |
|---|---|---|
| `monitoring` | `healthSummary`, the last 20 failed probes, the last 200 lines of `containerLogs`, open incidents, events from the last 7 days that match `deploy`/`operate`/`doctor` | read |
| `analytics` | PostHog data (A5). Without a PostHog config, the run fails with `posthog not configured`, and the agent writes a `low` finding that asks to set up PostHog. | read |
| `research` | `docs/spec.md` (or `input.md`), the `competitors` list, and earlier research findings | read, web search, and web fetch (Claude runner: `WebSearch`, `WebFetch`) |

When a run finishes, it also writes `docs/operate/<agent>.md` (summary and findings) so the lead can read it.

`dueAgents(store, config, now)` returns agents whose last run is older than their schedule. It returns nothing when `operate.enabled` is false, when the project is not live, or when a run is alive. The doctor tick runs due agents one at a time per project.

### A5. PostHog client

`src/operate/posthog.ts` uses `fetch` against `POST {host}/api/projects/{projectId}/query/` with a HogQL query and `Authorization: Bearer <key from env>`. It returns:

- weekly active users (this week and last week)
- pageviews per day for 14 days
- the signup funnel: steps come from events named in `docs/analytics.md` when that file exists, else `$pageview` → `signed_up` → the first custom event
- the top 10 custom events by count, with 30-day totals

Store the headline numbers in `metrics`. Failures (401, timeout) end the run as `failed`, with the HTTP status in the summary. Test it with a stubbed `fetch`.

### A6. Deploy env

`deployProject` passes `POSTHOG_KEY`, `VITE_POSTHOG_KEY`, and `POSTHOG_HOST` to the app container when `operate.posthog.publicKey` is set.

### A7. Findings to changes

`approveFinding(projectDir, store, id)` calls `openChange` with a request made from the finding (title, proposal, and evidence under a `Why:` line). It then sets the finding to `approved` with the change id. It throws the same errors as `openChange` (a run is alive, or a change is already open). `dismissFinding` sets `dismissed`.

### A8. API

In `src/ui/server.ts`:

- `GET /api/projects/<name>/operate` → `{ enabled, live, health: healthSummary, checks: last 7 days downsampled to at most 200 points, metrics: latest value and previous value per key, series: { wau, pageviews }, funnel, runs: last run per agent, config: { posthog: boolean, competitors: string[], schedule } }`
- `GET /api/projects/<name>/findings?status=open|approved|dismissed|all`
- `POST /api/projects/<name>/findings/<id>/approve` → 409 when `openChange` refuses; start the run with `startRunIfIdle`.
- `POST /api/projects/<name>/findings/<id>/dismiss`
- `POST /api/projects/<name>/operate/run` with `{ agent }` → 409 when that agent is already running; runs in the background like the lead chat.
- Add `openFindings: number` to the project list and detail payloads.

### A9. CLI

`agent-team operate <name> [--agent monitoring|analytics|research]` runs agents once and prints the findings. `agent-team findings <name>` lists open findings.

### A10. Templates

In `templates/react-vite` and `templates/fullstack`: add `posthog-js`, and initialize it in the client entry only when `import.meta.env.VITE_POSTHOG_KEY` is set. Capture `$pageview` automatically. Add a `track(event, properties)` helper, and document it in each template's `architecture.md` so workers use it for the spec's key actions. Add a line to `prompts/planner.md`: when the template has the helper, the plan tracks each core user action, and it lists the event names in `docs/analytics.md`.

## Group B: navigation shell (frontend)

### B1. Routes

- `/projects/:name/:phase?/:view?`. `phase` ∈ `build | launch | operate | system`. With no phase, go to the project's **current phase** (below) and that phase's `overview`.
- Legacy `?tab=` links redirect: `overview → build/overview`, `lead → build/lead`, `office → build/office`, `docs → build/docs`, `branding → build/branding`, `qa → build/qa`, `marketing → launch/marketing`, `attempts → system/calls`, `system → system/runtime`, `config → system/config`. Keep the `?doc=` and panel params.
- Current phase: `operate` when the project is `done` (per `projectStatus`) and deployed; `launch` when QA is approved and deploy or marketing are pending; else `build`.

### B2. Views per phase

| Phase | Views (sidebar order) | Content |
|---|---|---|
| Build | Overview, Lead, Office, Docs, Branding, Tasks, QA | Overview: `PipelineStepper`, `ChangeRequestCard` when relevant, `LiveAgentsCard`, `StatCards`, `EventsCard`. Tasks: `TasksCard` full width. The rest move as they are. |
| Launch | Overview, Marketing | Overview: `DeployCard`, `GithubCard`, and the deploy status. |
| Operate | Overview, Health, Analytics, Competitors, Next steps (badge = open findings), Changes | Group C |
| System | Agent calls, Runtime, Budget, Config | `AttemptsTab`, `SystemTab` + `RunnerHealthCard`, `BudgetCard`, `ConfigTab` |

Every project view shares one header: breadcrumb `Project / Phase / View`, title, status badge, the live preview button, and the resume button. Below the header, these show on every view: `GatePanel`, `ChangeMergeCard`, `IncidentBanner`, `StopBanner`, and `ProblemBanner`. They must not be lost.

### B3. Sidebar

Rebuild `web/src/components/app-sidebar.tsx` on the shadcn sidebar primitives (`Collapsible`, `SidebarMenuSub`). Use `collapsible="icon"`.

- Top: logo and a collapse button (`PanelLeftClose` / `PanelLeftOpen`, `aria-label` "Collapse sidebar" / "Expand sidebar"). Keyboard: the existing `Cmd/Ctrl+B` toggle. Remember the state (the shadcn cookie is fine).
- Section `Projects` with a `+` button for a new project. Each project row shows a status dot and a chevron. Only one project is expanded at a time: the one in the route. Clicking another project navigates to it and expands it.
- Inside a project: phase groups with a status icon. A done phase shows a green check. The current phase shows a violet dot. A future phase is muted but still clickable. The current phase is expanded; the others are collapsed until clicked. Then the views, with Lucide icons and badges (open findings on Next steps, blocked tasks on Tasks).
- Bottom: Incidents (with the open count), Settings, and the connection status, theme toggle, and log out that exist today.
- **Collapsed (icon rail):** logo, expand button, project avatars (initials, 2 letters, status dot), then the icons of the current project's views for its current phase, with a tooltip for each (`tooltip` prop on `SidebarMenuButton`), then Incidents and Settings.
- **Mobile (< 768 px):** the sidebar is a sheet (the shadcn default). It closes on navigation. The top bar shows the menu button, and the current `Project / View` instead of only the logo.

### B4. Mobile rules for every view

- No horizontal page scroll at 360 px width. Tables become stacked rows or scroll inside their card.
- Touch targets are at least 40 px tall.
- Multi-column layouts stack. Drill-downs (Changes) show one column at a time, with a back link.

## Group C: Operate views (frontend)

Use `GET /operate` and `/findings`. Poll every 30 s while the page is visible, and refresh when the project stream reports new events.

- **Overview** ("How it is running"): 4 stat cards (Uptime 7d, p95 latency, Weekly active users with delta and sparkline, and Signup conversion with delta). A card's dot color comes from the data: green when fine, amber when it got worse, red when down. Cards without data show "No data yet" and a link to set it up. Then "Open findings" (top 5, with a chevron to the detail) and "Suggested next steps" (top 3 open findings, each with **Create change**, which approves the finding). Footer: "Agents suggest. You approve."
- **Health**: current state, a 7-day uptime bar (one cell per hour, colored by status), a latency line for 24 h, recent failures, and the monitoring agent's last summary with a **Run now** button.
- **Analytics**: WAU and pageviews charts, the funnel bars, the top events table, and the analyst's summary with **Run now**. Without PostHog config: an empty state that explains the `operate.posthog` block and links to System → Config.
- **Competitors**: the competitor list, the researcher's last summary (Markdown), research findings, and **Run now**.
- **Next steps**: filter chips (All, Monitoring, PostHog, Competitors, and a Dismissed toggle). A list of rows with severity chip, title, evidence line, source agent, and chevron. The detail opens as a right panel on desktop and as a sheet on mobile: evidence, proposal, and **Approve as change** and **Dismiss** buttons. When approval returns 409, show the reason in a toast.
- **Changes**: the hierarchy drill-down. Column 1: changes (`C000 Initial build` is the original build: tasks with no `change`, and the phases). Column 2: the selected change's steps and tasks. Column 3: the selected task's agent calls, each with **Open transcript** (reuse `TranscriptSheet`). The selection lives in the URL (`?change=C003&task=T002`). On mobile, one column at a time with a back link. Keep `ChangeRequestCard` (the form to request a change) at the top of this view.

Charts: follow the existing chart style (see `budget-card.tsx`). If there is none, use plain SVG and design tokens. Add no new chart library.

## Verification

Add a seed script, `scripts/seed-operate.ts`, that writes health checks, metrics, findings, and one insight run per agent into an existing project's `state.db`. Use it to check every view in a browser, at 1440 px and 390 px wide.

## Group A decisions

Choices made where the spec is silent:

- **Health state.** `down` needs the last 3 probes to fail, like the event. `unknown` means no probe yet, or none in the last hour (the doctor is off). The p95 uses successful probes only.
- **Operate in the doctor.** Agents start in the background, one at a time per project, so a 10-minute agent call does not delay incident checks. `doctor --once` probes nothing and runs no agents.
- **A run is alive.** `dueAgents` skips a project while its build run is alive. An agent with a `running` row is not due, unless the row is older than 15 minutes (its process died).
- **Metrics are dated by day**, so a second run on the same day replaces the first. A run also writes last week's WAU under the date 7 days back. With daily runs, `previous` is yesterday's value.
- **Funnel.** Steps come from a `## Funnel` section in `docs/analytics.md` (backticked event names). The count per step is distinct people over 30 days, not a strict ordered funnel.
- **Top events** are stored as `event.<name>` metrics and returned as `topEvents` in `GET /operate`. The spec's response has no field for the Analytics view's top events table.
- **`metrics` in `GET /operate`** holds headline keys only (`wau`, `signups`, `signup_conversion`, `pageviews`); funnel and event rows have their own fields.
- **`GET /findings`** defaults to `status=open`. Findings are sorted by severity, then newest first.
- **Approve** answers `201 { changeId, branch, started }`. A finding that is not open answers 409; an unknown id answers 404.
- **CLI** commands take `<projectDir>`, like every other command, not `<name>`. `operate` runs the agents now, whatever the schedule, and exits 1 when one fails.
- **`docs/operate/<agent>.md`** is written to the main checkout and not committed.
- **Templates** are now v2. The client sends events to `VITE_POSTHOG_HOST` or `https://us.i.posthog.com` (the ingestion host). `POSTHOG_HOST` is the API host that the deploy passes to the app.
- **Planner.** Rule 16 applies only when the task prompt says the template has a `track()` helper. The planner may write `docs/analytics.md` next to `tasks.json`.
- **Roles** `monitor`, `analyst`, and `researcher` default to Claude Opus 5.5 (`claude-opus-5-5`). Codex has no web search tools, so the researcher needs Claude.
