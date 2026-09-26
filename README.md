<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo/horizontal-dark.svg">
  <img alt="agent-team" src="docs/brand/logo/horizontal-light.svg" width="320">
</picture>

A self-hosted orchestrator that turns a plain-text product brief into a working web app or API. A team of AI agents writes the spec, architecture, branding, design system, and task plan. Scoped worker agents then build the tasks, several at once (`parallelTasks`), and a reviewer checks each one.

![A team of agents passing work around the agent-team hexagon](docs/brand/assets/readme-hero.png)

All roles default to Claude. The illustrator uses Codex, because it generates the logo and screen images. Any role can use any supported runner.

## Requirements

- Node.js 22.18 or later (runs TypeScript directly, uses built-in `node:sqlite`)
- git
- The `claude` CLI (Claude Code), logged in
- The `codex` CLI, logged in (used for image generation)
- Docker (agent sandbox, QA screenshots, and the live preview)
- The `gh` CLI, logged in with the `project` scope, if you want GitHub publishing

## Install

```sh
npm install
npm run build:ui
```

`npm run build:ui` builds the dashboard in `web/` into `web/dist/`. Run it again after you pull changes to `web/`.

## Quick start

Most work happens in the dashboard. You type the brief in a form, and the agents take it from there.

1. Start the dashboard with the folder that will hold your projects:

   ```sh
   CLAUDE_CODE_OAUTH_TOKEN=... node src/cli.ts ui ~/projects --port 4400
   ```

   The server starts agent runs itself, so it needs `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in its environment.
2. Open `http://127.0.0.1:4400` (see [Access](#access) to reach it from another machine).
3. Click **New project** and fill in the form:

   | Field | What it does |
   | --- | --- |
   | Project name | Folder and repository name. Lowercase letters, digits, and dashes. |
   | Product brief | Your idea in plain words: who uses it and what they can do. The PM agent turns it into a spec. |
   | Target | Web app, API, or both. |
   | Stack | **Custom** (default): the architect chooses the stack. Or a [stack template](#stack-templates) for the chosen target. |
   | Worker provider | Claude (default) or Codex for the workers that write the code. |
   | Approval gates | Phases where the run stops for your review: spec, architecture, branding, design, plan. |
   | Create GitHub repo | Repository, one issue per task, a pull request per phase and task, and a project board. |
   | Deploy when ready | Runs the finished app and gives you a public preview URL. |
   | Branding | Generates the logo and the main screens before the design phase. |

4. Click **Start build**. The project page shows the pipeline, tasks, live events, agent calls, cost, and elapsed time (only while a run is active).

![The New project form with the brief, target, agent models, and approval gates](docs/screenshots/02-new-project.png)

![A running project: pipeline, cost, tasks, and live events](docs/screenshots/03-project-running.png)

![A finished project with its live preview](docs/screenshots/04-project-live.png)

## Working with a run

| Situation | What you see | What to do |
| --- | --- | --- |
| A phase waits at a gate | An approval panel with the phase output (docs, branding images, task list) | **Approve** to continue, or write notes and click **Request changes**. The agent redoes the phase with your notes. |
| A task needs a decision | A card with the reason and, for a scope request, the files the worker asked for | **Approve and retry** adds the files to the task (it waits for any unfinished task that owns one). **Reject** drops the task. With `autonomy.autoApproveScope: true` (Config tab, **Decisions**), scope requests are approved without stopping, at most twice per task. |
| The run stopped or paused | A banner with the reason and the key error lines | Fix the cause, then **Resume run**. |
| The run hit its budget | A budget banner | **Raise budget and resume** adds 50% to `budget.runUsd`. |
| QA failed | The QA tab: findings, test output, and each screenshot next to its branding image | Nothing. Fix tasks run on their own, up to `qa.maxRounds`. |
| You have a question about the run | The **Lead** tab: a chat with the project lead agent. It reads the project state, docs, and transcripts, and suggests actions such as retry or resume. | Ask in plain words. Click a suggested action to apply it. The lead never changes the project on its own, and chat cost does not count against the run budget. |
| The app is live | A **Live** badge and the preview URL | Open it. |

## Access

The dashboard listens on `127.0.0.1` by default (change it with `--host`). On loopback with no login set, it opens without a password, as before. Once you set a login, every `/api` route needs it, on loopback too.

### Turn on the login

1. Make a password hash. The command asks twice and does not echo; you can also pipe the password in.

   ```sh
   node src/cli.ts hash-password
   ```

2. Make a session secret, so a restart does not log everyone out:

   ```sh
   node src/cli.ts session-secret
   ```

3. Set both before you start the dashboard:

   ```sh
   export AGENT_TEAM_UI_PASSWORD_HASH='scrypt$32768$8$1$...'
   export AGENT_TEAM_UI_SESSION_SECRET='...'
   ```

   Use single quotes: the hash contains `$`. `AGENT_TEAM_UI_SESSION_HOURS` sets how long a login lasts (default 168, one week).

A login sets an HttpOnly cookie. Five wrong passwords from one address lock it for 15 minutes; 30 wrong passwords from anywhere lock all logins for 15 minutes. To log everyone out, change the session secret and restart.

### Let a proxy do the login

If a reverse proxy already logs users in (Authelia, Caddy, Tailscale), let it pass the user name in a header:

```sh
export AGENT_TEAM_UI_TRUSTED_PROXIES=172.17.0.0/16
export AGENT_TEAM_UI_PROXY_USER_HEADER=Remote-User
```

The server reads the header only from the listed IPs or CIDRs. You can set this and a password together. For a team, prefer the proxy: the logs then show who did what, while the shared password logs everyone as one user.

### Reach it from another machine

- SSH tunnel: `ssh -L 4400:127.0.0.1:4400 you@server`, then open `http://localhost:4400`.
- Tailscale: `tailscale serve --bg --https=4400 http://127.0.0.1:4400`, then open `https://<machine>.<tailnet>.ts.net:4400`. Only devices on your tailnet can reach it. Never use `tailscale funnel` without a login: it puts the dashboard on the internet.
- Reverse proxy: run with `--host` on an address the proxy can reach, such as the docker0 gateway `172.17.0.1`, and add the proxy's host name to `AGENT_TEAM_UI_HOSTS`. The Dokploy deploy in `docker-compose.yml` does this for `agent-team.137-131-153-58.sslip.io`. Put the hash and secret in `~/.config/agent-team/doctor.env` on the host; the container reads that file at start.

In the Dokploy deploy, `AGENT_TEAM_RUN_IMAGE` makes each run start in its own container (`agent-team-run-<project>`), from the image that was live when the run started. A redeploy restarts the dashboard and the doctor but leaves running builds alone. Without the variable, a run is a child process of the dashboard, as on a laptop.

The server refuses to listen on a non-loopback address without a login. `--insecure-no-auth` skips that check for setups where a proxy does the login and you do not want to list it; the server prints a warning at every start. Anyone who reaches an open port can start paid agent runs and read every project file.

The server answers only `localhost`, `127.0.0.1`, and `*.ts.net` hosts; add others with `AGENT_TEAM_UI_HOSTS`.

## Command line

Everything the dashboard does also works from the command line, which is useful for scripts:

```sh
node src/cli.ts init ~/projects/my-app --brief brief.md   # create a project from a brief file
node src/cli.ts init ~/projects/my-api --brief brief.md --target api --template node-api
node src/cli.ts templates                                 # list the stack templates
node src/cli.ts run ~/projects/my-app                     # start or resume the run
node src/cli.ts change ~/projects/my-app --request change.md   # open a change request, then run
node src/cli.ts approve ~/projects/my-app spec            # approve a gate, then run again
node src/cli.ts status ~/projects/my-app                  # open change, phases, tasks, and cost
node src/cli.ts retry ~/projects/my-app T007              # retry a blocked task
node src/cli.ts deploy ~/projects/my-app                  # redeploy the live preview
node src/cli.ts undeploy ~/projects/my-app                # stop the live preview
node src/cli.ts operate ~/projects/my-app --agent research   # run Operate agents now and print findings
node src/cli.ts routines ~/projects/my-app --run weekly-social-posts   # run a routine now
node src/cli.ts findings ~/projects/my-app                # list open findings
node src/cli.ts backlog ~/projects/my-app --add "Dark mode"   # add your own backlog item
node src/cli.ts sprint ~/projects/my-app --now            # start a sprint now
node src/cli.ts sprints ~/projects/my-app                 # list the sprints
node src/cli.ts backlog ~/projects/my-app --add "Dark mode"   # add your own backlog item
node src/cli.ts sprint ~/projects/my-app --now            # start a sprint now
node src/cli.ts sprints ~/projects/my-app                 # sprint history
node src/cli.ts doctor ~/projects                         # watch every project and repair stopped runs
node src/cli.ts notify-test ~/projects --channel phone    # send a test notification
```

`init` creates the folder, runs `git init`, writes `input.md`, and copies `pipeline.example.yaml` to `pipeline.yaml`. Edit `pipeline.yaml` to choose models, gates, and budget.

## Stack templates

A stack template is a tested scaffold with fixed commands. Pick one to skip the scaffold work: the architect designs inside the template, the planner adds no scaffold task, and QA, smoke checks, and deploy read the commands from it.

| Template | Target | Stack |
| --- | --- | --- |
| `node-api` | api | Node.js, TypeScript, Fastify, SQLite (`node:sqlite`), `node:test` |
| `react-vite` | web | React, Vite, Tailwind CSS v4, shadcn/ui, Lucide, Vitest; static build served with `serve` |
| `fullstack` | web+api | One Fastify server for `/api` and the built React client (same client stack as `react-vite`) |
| `custom` | any | No template. The architect chooses the stack, as before. This is the default. |

How it works:

- The first commit of the project is `chore: start from <name> template v<version>`. It holds the scaffold and `stack.json`, a copy of the manifest. Workers may not edit `stack.json`.
- `pipeline.yaml` pins the template: `template: { name: node-api, version: 1 }`.
- The architecture phase fails if `## Commands` in `docs/architecture.md` or `AGENTS.md` differs from the template, or if `deploy.json` changed.
- The plan phase fails if a feature task lists a file from the template's `sharedPaths`.
- A stack hint under `avoid` that names a tool of the template loses, and the run logs a `template` event.
- Each run logs one `commands` event with the install, test, and deploy commands and where they came from.
- A project keeps the version it started from. The Config tab shows "v2 available" when the template is newer. There is no upgrade. A project whose template folder is deleted keeps working from its `stack.json`.

Templates live in `templates/<name>/`: `template.json` (the manifest), `architecture.md` (notes for the architect and a CHANGELOG), and `scaffold/` (the files copied into the project). Bump `version` on any scaffold or command change. `npm run test:templates` copies each scaffold to a temp folder and runs install, typecheck, test, build, and start. It needs network access, so `npm test` does not run it.

## Pipeline

| Phase | Role | Output |
| --- | --- | --- |
| spec | PM | `docs/spec.md` |
| architecture | Architect | `docs/architecture.md`, `docs/adr/*`, `contracts/openapi.yaml` |
| concepts | Illustrator, then Design reviewer; a person (or the Design reviewer) picks one | `design/concepts/<a, b, c>/`: `logo.png`, `landing.png`, `style.md`, their prompts, and `design/concepts/README.md` |
| branding | Illustrator, then Design reviewer | `design/branding/01-logo.png`, desktop screens `02-<screen>.png` and later, mobile screens `02-<screen>.mobile.png`, `design/branding/README.md` |
| design | Designer, then Design reviewer | step 1: `design/tokens.css`, `design/logo.svg`, `design/logo-mark.svg`, `docs/design-system.md`; the orchestrator renders `design/favicon/`; step 2: `docs/design.md` |
| marketing | Marketer, then Design reviewer | `marketing/copy.json`, `marketing/art/*`; the orchestrator renders `marketing/<piece>-<format>.png` and `marketing/manifest.json` |
| plan | Planner | `tasks.json` |
| build | Worker, then Reviewer; Design reviewer for UI tasks | code and tests, one or more atomic commits per task |
| qa | QA | `.agent-team/qa/round-<n>/`: test output, screenshots, `report.json`, verdict; fix tasks `Q<round><n>` in `tasks.json` |
| deploy | none | live preview URL |

### Concepts, branding, and the design process

The phases copy the process that designed agent-team's own dashboard: choose between real alternatives, fix the style, then draw every screen from a finished screen.

1. **Concepts.** The illustrator draws `branding.variations` (default 3) distinct directions, each from a different style in the [style catalog](docs/design-styles.md) (3D, editorial, bento, brutalist, Swiss, and more). Set `branding.style`, or the **Visual style** field in the form, to use one style for every direction. Each direction has a logo, a landing page at 1440×900, and a style block: hex values per color role, a font pair, Lucide icons, and a radius. With `concepts` in `autonomy.gates` (the default), the gate shows the directions side by side. Pick one and click **Approve direction B**, or run `agent-team approve <dir> concepts --choice b`. **Request changes** redraws the directions with your notes. Without the gate, the design reviewer picks one (`prompts/concept-picker.md`) and logs why. Set `branding.variations` to 0 or 1 to skip the phase. Projects whose branding already exists skip it too.
2. **Branding.** The illustrator starts from the chosen logo and landing, and repeats the style block in every screen prompt. Each screen is drawn with the landing attached as the style reference, with the layout in pixels, NOT rules, and every visible string written out. Each prompt is saved as `<image>.prompt.txt`, and the README ends with a `## Style` section. With `branding.dark` (default `true`), the landing is also redrawn as `02-landing.dark.png` by style transfer. The designer takes the `.dark` tokens from it.
3. **Change requests.** When a change's architecture delta says `Design: needed`, the illustrator draws only the new screens before the designer runs. It uses the saved prompts, the Style section, and screenshots of the running app from the last QA round as the style reference. The screenshots go in `.reference/` for the agent and are removed before the commit.

`branding.count` (default 4, 2 to 6) sets the number of branding images, logo included. `branding.mobile` (default `true`) adds a phone version of every desktop screen. Set `branding.enabled: false` to skip the phase. Older `pipeline.yaml` files with a `mockups:` key, and `mockups` in `autonomy.gates`, still work.

### Marketing

After the design phase, the `marketer` role (default `codex`) writes launch images for the product. For each piece it writes a headline, a subtitle, and a call to action in the language of `input.md`. Then it picks the image that best shows the problem the product solves:

- **Stock photo:** searched on [Openverse](https://openverse.org) (no API key) and saved with its credit and license.
- **Generated:** drawn with Codex image generation when no good photo exists.

The images carry no text. The orchestrator renders the text, the logo, and the brand tokens over each image with Playwright, offline, in every format in `marketing.formats`: `og` (1200×630), `square` (1080×1080), `story` (1080×1920), and `x` (1600×900). The headline shrinks until it fits. The design reviewer checks the result, and the dashboard's **Marketing** tab shows every piece with download buttons. Add `marketing` to `autonomy.gates` to approve the pieces before the plan. Projects planned before this phase existed skip it.

### Design review and commits

- **Design reviewer** (`design-reviewer` role, default `claude opus`, read-only) approves the branding and design output. On a rejection the phase agent fixes its files in place and the reviewer checks again, once. A second rejection fails the attempt.
- **Favicon.** After design step 1, the orchestrator renders `design/logo-mark.svg` in the Playwright container into `favicon.ico` (16, 32, 48), `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, a maskable icon, and `site.webmanifest`. The mark must use literal colors and a square `viewBox`. The render needs Docker; without it the phase pauses.
- **Commits.** Branding and design land as one commit per step: logo, desktop screens, mobile screens; tokens, logo, favicon, design system, screens. A worker may end its message with a `{"commits":[{"message","files"}]}` block to split a task into atomic commits. An invalid plan falls back to one commit.
- **UI tasks.** The smoke check loads each route on desktop and on a phone (iPhone 13 viewport). A page that scrolls sideways or has tap targets under 24px fails the attempt. After the code review passes, the design reviewer compares the screenshots with `docs/design.md` and the branding.

### Landing page and demo login

- **Landing page.** For web targets, `US-01` is a public landing page at `/`. The illustrator draws it as `02-landing.png`, the designer specifies it, and the planner adds a task for it.
- **Demo account.** The orchestrator creates one demo account per project (`demo@example.com` and a random password) and keeps it in `state.db`, never in git. Every run of the app gets it as `DEMO_EMAIL` and `DEMO_PASSWORD`: in smoke checks, in QA, and in deploy. The app seeds that user at startup.
- **Signed-in screens.** Screens with `Access: signed in` in `docs/design.md` are captured after the browser logs in at the `Login: /path` page. If the login fails, the check fails.
- **Access.** The dashboard's live deployment card shows the email and password, with copy buttons.

Role prompts live in `prompts/`. Edit them to tune behavior.

State lives in `<projectDir>/.agent-team/`: `state.db` (SQLite) and agent transcripts.

## QA

After every task is merged and before deploy, QA checks the build. Configure it in `pipeline.yaml`:

```yaml
qa:
  enabled: true
  maxRounds: 3       # failed rounds before the run stops for a human
  resolveAll: false  # true: QA passes only with no findings left; minor ones get fix tasks too
```

Each finding has a severity: `blocker`, `major`, or `minor`. Without `resolveAll`, QA may pass with minor notes. With it, the orchestrator rejects a pass that still lists findings, so every finding becomes a fix task. `maxRounds` still caps the rounds.

Each round:

1. **Tests.** Runs the `install` and `test` commands from `## Commands` in `docs/architecture.md` on a fresh worktree of `main`, in the same sandbox as workers.
2. **Screenshots.** Starts `main` the way deploy does, in container `agent-team-qa-<project>` with no tunnel. A Playwright container (`agent-team-qa-shot-<project>`, built from `mcr.microsoft.com/playwright`) loads every `Route:` line in `docs/design.md` plus `/design-system` at 1440x900 and on a phone, full page, and records the HTTP status and console errors. The browser joins only a per-project internal network, so it reaches the app and not the internet. Both containers and the network are removed after the round. Skipped for `api` targets.
3. **Review.** The `qa` role (default `claude opus`, read-only) compares the screenshots with the branding images and `docs/design-system.md`, and answers `pass` or `fail` with findings and fix tasks.

On pass, deploy runs. On fail, the fix tasks are added to `tasks.json`, built by the worker and reviewer, and QA runs again. After `maxRounds` failed rounds, the run stops with the last fix tasks queued; "Resume run" builds them and starts a new round. A failed test run, an app that does not start, a route that does not load, or a mobile page that scrolls sideways or has tap targets under 24px always fails the round.

The dashboard's QA tab shows each round: verdict, findings, test output, and every screenshot next to its branding image.

## Sprints and learning

A deployed app keeps improving on its own, and every project makes the next one better. See [docs/sprints.md](docs/sprints.md).

- **Sprints** (`sprints.enabled`). Set them on **Operate > Sprints > Sprint settings**, or in `pipeline.yaml`. Every `sprints.everyDays` (default 7), the doctor starts a sprint on a live app. The `evaluator` scores the app from 0 to 100 against the brief, and its gaps join the backlog. The `pm` picks one goal and up to `sprints.maxItems` backlog items: Operate findings, evaluator gaps, its own feature ideas (`sprints.newFeatures`), and items you added. They ship as one change request, with QA, a merge, and a redeploy. `sprints.budgetUsd` caps one sprint and `sprints.monthlyUsd` caps 30 days. **Operate > Sprints** shows the plan and the history; **Start sprint now** skips the wait.
- **Learning** (`learning.enabled`). After each run and each sprint, the `curator` role reads the new rejection reasons, QA findings, evaluation gaps, and incident diagnoses. It turns them into lessons in `<runs folder>/.agent-team-lessons/lessons.json`. Every agent call gets the strongest lessons for its role in its system prompt. A lesson that comes back gains weight, an unused one fades (30-day half-life), and a harmful one is retired. Lessons tied to a stack (for example `next`) reach only projects that use it.
- **Solution memory** (`learning.memory`). Every merged task goes into a shared search index (SQLite FTS5). Each worker gets the closest solutions from other projects, with their summary and diff.

## Live preview

With `deploy.enabled: true`, the orchestrator runs the finished app from `main` in a container and exposes it through a Cloudflare quick tunnel. You get a random public URL such as `https://welding-apps-symphony-registrar.trycloudflare.com`, with no account, domain, or open port.

- How to start the app: `deploy.json` from the architect (`install`, `start`, `port`), else `npm start`, else a static `index.html`.
- The app runs in `node:24-bookworm` (it can build native modules) with 2 GB of memory and 2 CPUs. It gets its public URL in `APP_URL`, `PUBLIC_URL`, `BASE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXTAUTH_URL`, and `ORIGIN`, so the links it builds are not localhost.
- The URL goes to the logs, `status`, the dashboard, the GitHub epic, and the repository homepage.
- `agent-team deploy <projectDir>` redeploys; `agent-team undeploy <projectDir>` stops it.
- Quick tunnels have no uptime guarantee, and the URL changes if the tunnel container restarts. For a stable address, use a named Cloudflare tunnel with your own domain.
- Anyone with the URL can reach the app. Do not deploy apps that hold real data.

### App secrets

Keys that only a person can create (a Google OAuth client, a payment or email API key) are declared by the app in `.env.example`. The build and QA use fakes. Deploy waits until you enter or skip each required key on the dashboard, under **Launch → Secrets**, or under **Settings → Shared secrets** for values that several projects use. Values are encrypted with `AGENT_TEAM_SECRETS_KEY`, which you set on the host:

```sh
AGENT_TEAM_SECRETS_KEY=$(openssl rand -base64 32)
```

See [docs/secrets.md](docs/secrets.md).

## Change requests

A finished project can take changes without a rebuild. Once the run is complete, the project page shows **Request a change**. Describe the change ("add CSV export to the reports page") and submit it. From the command line, write it to a file and run `agent-team change <projectDir> --request change.md`, then `agent-team run <projectDir>`.

Each change gets an id (`C001`, `C002`, ...) and a branch `change/<id>-<slug>` from `main`. The run then:

1. Reruns spec, architecture, and plan in change mode. Each agent writes a delta in `docs/changes/<id>/` and updates `docs/spec.md`, `docs/architecture.md`, and `AGENTS.md` in place. The design phase reruns only when the architecture delta starts with `Design: needed`. Branding and marketing never rerun.
2. Builds only the new tasks. The planner writes them to `docs/changes/<id>/tasks.json`, and the orchestrator appends them to `tasks.json` with `"change": "<id>"`. Merged tasks do not run again.
3. Lands every phase and task on the change branch. `main` and the live app stay as they are.
4. Runs the full QA on the change branch. QA judges the change's routes against the spec delta and fails other routes only on regressions.
5. Merges the branch into `main` once, with a merge commit (a pull request titled `feat: <request>` when GitHub is on), then redeploys.

Only one change is open at a time. Gates work as for the first build, and the gate panel shows the change's delta. Set `autonomy.changeMerge: manual` in `pipeline.yaml` to approve the final merge yourself.

When a change needs no code, its docs merge without a build, QA, or a redeploy. When `main` moved during the change (a doctor hotfix), the run merges `main` into the change branch first; on a conflict it stops and names the files. **Abandon** in the change history puts the phases back, removes the change's tasks, and closes its GitHub issue and pull requests. The branch stays for reference.

The change history lists each change with its status, branch, pull request, dates, and cost. Data migrations on a live app are out of scope.

## Import an existing project

agent-team can take over an app it did not build. Click **Import project** on the Projects page, or run `agent-team import <projectDir> --from <git-url|folder> [--url <url>]... [--github source|new|none]`, then `agent-team run <projectDir>`.

| Field | What it does |
| --- | --- |
| Source | A git URL (cloned) or a local folder (cloned with its history, or copied without `node_modules` and build output). The original never changes. |
| Extra URLs | Optional. The live site, the docs, or other pages. The importer reads each one. |
| GitHub destination | `source`: issues and pull requests on the imported GitHub repository (needs push access and a `main` default branch; no project board). `new`: a new repository, as for a new project. `none`: local git only. |
| Approval gates | Any of spec, architecture, design. |

The import run documents the app as it is. It changes no app code.

| Phase | Role | Output |
| --- | --- | --- |
| research | Importer (reads the code, fetches the URLs) | `docs/import/research.md` |
| spec | PM | `docs/spec.md` |
| architecture | Architect | `docs/architecture.md`, `AGENTS.md`, `deploy.json` |
| design | Designer | `design/tokens.css`, `docs/design-system.md`, `docs/design.md` from the existing styles |
| baseline | none | runs install and tests, screenshots every route into `design/branding/<route>.png`, writes `.agent-team/import/baseline.json` |

Branding, marketing, plan, and build do not run. When the import ends, the project page shows **Request a change**, and all later work goes through [change requests](#change-requests).

The baseline never blocks the import. QA on later changes fails a round only on a **regression**: a test that passed, a route that loaded, or an app that started at import. Failures that were already there show as **Pre-existing** on the QA tab and create no fix tasks. After a change merges with a QA pass, its result becomes the new baseline. When the baseline has failures, the project page suggests a cleanup change; it starts only when you click **Start cleanup change**.

## Operate

After deploy, three agents watch the live app and write **findings**: a problem, its evidence, and one proposed change.

| Agent | Reads | Default schedule |
|---|---|---|
| monitoring | health probes, the app log, incidents, and deploy events | every 24 hours |
| analytics | PostHog: weekly active users, pageviews, the signup funnel, top events | every 24 hours |
| research | the spec and the competitors in `operate.competitors`, with web search | every 7 days |

The doctor (`agent-team doctor`) probes each live app every 5 minutes and runs due agents. **Run now** in the dashboard, or `agent-team operate <projectDir>`, runs one at once. Findings join the backlog. With [sprints](#sprints-and-learning) on, the next sprint picks from it; **Approve as change** turns one finding into a change request at once. Configure it under `operate:` in `pipeline.yaml`; `enabled: false` turns it off.

The three agents are built-in [routines](#routines). Set their schedules on **Operate > Routines**.

For analytics, create a PostHog project, set `operate.posthog` (`projectId`, `publicKey`, and `apiKeyEnv`, the name of the env var that holds a personal API key), and redeploy. The `react-vite` and `fullstack` templates send page views and `track()` events only when the key is set. To try the views with demo data, run `node scripts/seed-operate.ts <projectDir>`.

## Routines

A routine is a recurring job for one agent: the `marketer` makes social images every week, or the `researcher` scans search terms every two weeks. You create them on **Operate > Routines**, from a template or from scratch. See [docs/routines.md](docs/routines.md).

- **When:** every N days, after each sprint, after each deploy, or by hand.
- **Output:** findings for the backlog, a report in `docs/routines/`, or images in `marketing/routines/`. Routines write only inside the project.
- **Tools** come from the role. The `marketer` runs on codex, so it can generate images.
- **Money:** `budgetUsd` caps one run, and `routines.monthlyUsd` caps 30 days of all routines.

## GitHub

Set `publish.github.enabled: true` to run the whole process in the open on GitHub:

| Step | What happens |
| --- | --- |
| First merge | Creates the repository (private by default) and the labels. |
| Plan written | Opens an epic issue with the brief, one issue per task (acceptance criteria, scope, verify command, dependencies), and a GitHub Projects board with every issue. |
| Each phase and task | Lands through a pull request (`Closes #N`, reviewer verdict, attempt count), merged on GitHub. Local `main` follows. |
| Failed attempt | Posts the failure reason as a comment on the task issue. |
| Blocked task | Adds the `blocked` label and a comment. |
| Board | Todo, In Progress, and Done follow each task. The epic closes when the build completes. |

It all runs on the host, so GitHub credentials never enter a container. If a GitHub step fails, the orchestrator logs it and merges locally.

One-time host setup: `gh auth login`, `gh auth refresh -h github.com -s project`, and `gh auth setup-git`.

## Harness

The harness runs every agent call. It isolates each attempt, retries infrastructure failures, and falls back to other models.

| Concern | Behavior |
| --- | --- |
| Workspace | Each task attempt gets a fresh git worktree on branch `agent/<task>-<attempt>`, created from `main`. A failed attempt is thrown away and never touches `main`. A passing attempt is rebased on `main` and merged fast-forward. |
| Sandbox | With `harness.isolation: docker`, each agent call and verify command runs in its own container: read-only root, only the worktree writable, all capabilities dropped, CPU, memory, and process limits. The CLIs get copies of their auth files, never the real directories. |
| Network | Agent containers join an internal Docker network with no route out. Their only exit is the `agent-team-proxy` container (tinyproxy), which allows HTTPS to an allowlist: Claude, OpenAI, npm, PyPI, GitHub, nodejs.org, plus `harness.network.extraDomains`. |
| Credentials | Containers get copies of `~/.claude/.credentials.json` and `~/.codex/auth.json`. Tokens refreshed inside a container are written back to the host. If `CLAUDE_CODE_OAUTH_TOKEN` is set (from `claude setup-token`), it is passed by name instead. |
| Setup | Each fresh worktree installs dependencies first (`npm ci`, `pnpm`, or `yarn`, detected from the lockfile). |
| Failure classes | `rate_limit`, `auth`, `unavailable`, `missing_binary`, `timeout`, `aborted`, `agent_failure`. Only runner output (stderr, error events) is classified, never the agent's own work. |
| Retry | `unavailable` retries the same model with exponential backoff (`transientRetries`, `backoffMs`). |
| Fallback | `rate_limit`, `auth`, `missing_binary`, and `timeout` move to the next entry in the role's `fallbacks`. |
| Cooldown | A rate-limited runner rests for `cooldownMs` (4x after an auth error) and is skipped meanwhile. When every runner rests, the harness waits up to 1 hour, then pauses the run. |
| Attempts | Infrastructure failures pause the run without using up a task's attempts. Only agent failures count toward `maxRetries`. |
| Scope | Claude workers can edit only their task's `allowedPaths`; other edits are denied at once. A check after the run catches the rest. |
| Blocked tasks | A worker that cannot finish in scope reports why. The planner may widen the scope, add a prerequisite task, or split the task, once. Changes to shared or foreign files wait for you. |
| Retries | A retry gets the rejected diff and the reason. A failing check runs twice before it counts, to catch flaky tests. |
| Shared context | The architect writes `AGENTS.md` (loaded by both CLIs). The harness appends each merged task to `docs/progress.md`. Workers also get a map of the files. |
| Budget | `budget.perTaskUsd` per task and `budget.runUsd` (default 30) per project. |
| Stop | Ctrl+C stops the agents, kills their containers, and removes worktrees. Run again to resume. Exit code 75 means paused. |

Commands: `agent-team reset-cooldowns <projectDir>` clears runner cooldowns after you fix a login.

## Doctor

`agent-team doctor <runsDir>` watches every project in `runsDir`. Every 60 seconds it checks each run. When a run stops for a reason a machine can fix, it opens an incident, asks a doctor agent to diagnose and fix it, and resumes the run. `--once` checks one time and exits, for cron and tests.

![The Incidents page lists each incident with its status, cause, cost, PR, and issue](docs/screenshots/06-incidents.png)

### What counts as an incident

| Run state | What the doctor does |
| --- | --- |
| Stopped as `failed` or `paused` | Opens an incident. |
| Alive, but nothing logged for `stallMinutes` (and longer than the agent timeout plus 5 minutes) | Opens a `stalled` incident. It stops the run before it resumes it. |
| Exited without recording why (for example killed) | Opens a `crashed` incident. |
| Paused because every runner is cooling down | Waits for the cooldown, resumes once, and opens an incident only if the run pauses the same way again. |
| Completed, waiting at a gate, or stopped with Ctrl+C | Nothing. |
| Budget reached, or a replan that needs a person | Opens one GitHub issue and does not act. |

The same stop (same kind and first line, ignoring times and amounts) never gets a second open incident.

### How it repairs

1. It prepares a git worktree of the agent-team source clone on branch `doctor/<project>-<incident>`, with a read-only `.incident/` folder: the stop reason, `status` output, the last 300 log lines and events, `tasks.json`, `pipeline.yaml`, and the last 6 transcripts of the failing task or phase.
2. The doctor agent (role `doctor`, default Claude Opus, prompt `prompts/doctor.md`) runs in the same sandbox as the workers. It answers with a diagnosis, a cause, a code fix or none, and project actions: `retry`, `reset_cooldowns`, `edit_task` (widens `allowedPaths` under the same rules as a replan), or `resume`.
3. For a code fix, the orchestrator checks that a file under `test/` changed, runs `npm ci`, `npx tsc --noEmit`, and `npm test`, commits, pushes the branch, and opens a pull request with `gh pr create`. When an open doctor pull request changes the same files, the new branch builds on it. The doctor never force-pushes.
4. It copies the changed files into the live install (the folder `src/cli.ts` runs from), runs the project actions, and resumes the run.
5. Once the resumed run gets past the failing point, it merges the pull request with a merge commit and deletes the branch. A stacked pull request waits until the one below it merges. When a merge fails, the issue gets one comment and a person merges it. Set `autoMerge: false` to merge by hand.

Incidents live in `<project>/.agent-team/incidents/<id>.json`. The dashboard lists them on the Incidents page and shows an open one as a banner on the project page.

On the agent-team repo, the doctor opens one issue per incident (label `incident`), comments when it diagnoses, opens a pull request, resumes, sees the run pass the failing point, merges, or gives up, and closes the issue once the live install runs the merged fix. An incident without a pull request closes when the project's run completes.

### Settings

Put them in `<runsDir>/doctor.yaml`. All are optional:

```yaml
stallMinutes: 45          # quiet time before a live run counts as stalled
maxAttempts: 3            # doctor attempts per incident
maxUsdPerIncident: 15     # doctor cost per incident; doctor calls do not use the project's run budget
sourceDir: ~/agent-team-src
repo: owner/agent-team    # default: the source clone's origin
autoMerge: true           # merge the fix once the resumed run gets past the failing point
role: { runner: claude, model: opus }
```

After `maxAttempts` or `maxUsdPerIncident`, the incident is marked `gave_up`, the issue gets a comment, and the doctor leaves that stop alone.

### Source clone and hotfixes

The doctor needs a git clone of agent-team at `sourceDir`. If it is missing and `repo` is set, the doctor clones it with `gh repo clone`. It fetches `origin` before it works on an incident.

A hotfix lives only in the live install until its pull request is merged and pulled there. Deploying from a laptop with rsync overwrites hotfixes, so merge and pull doctor pull requests first. The doctor process keeps its own code in memory; restart it to pick up a fix to the doctor itself.

### Run it as a systemd user service

`~/.config/systemd/user/agent-team-doctor.service`:

```ini
[Unit]
Description=agent-team doctor
After=network-online.target docker.service

[Service]
WorkingDirectory=%h/agent-team
# From `claude setup-token`; a file with CLAUDE_CODE_OAUTH_TOKEN=... and mode 600
EnvironmentFile=%h/.config/agent-team/doctor.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning %h/agent-team/src/cli.ts doctor %h/projects
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

Use the path from `command -v node` in `ExecStart`. Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-team-doctor
loginctl enable-linger "$USER"      # keep it running after you log out
journalctl --user -u agent-team-doctor -f
```

The service needs `gh` logged in for the same user (`gh auth login`, `gh auth setup-git`), because it pushes branches and opens issues and pull requests.

## Notifications

agent-team can tell you when a run needs you, so you do not have to watch the dashboard. It sends to ntfy (phone push), Slack, a generic webhook, or email.

### Set it up

1. Copy [`notifications.example.yaml`](notifications.example.yaml) to `notifications.yaml` in the runs folder (next to `doctor.yaml`). One file covers all projects. Without the file, notifications are off.
2. Put secrets in environment variables and refer to them as `${NAME}`. Quote the value when it sits inside `{ }`: `password: "${SMTP_PASSWORD}"`.
3. Restart `agent-team ui` or the doctor so the process has the variables.
4. Send a test: `node src/cli.ts notify-test ~/projects`, or open **Settings > Notifications** in the dashboard.

### What you get

| Notification | When | Needs you |
|---|---|---|
| `gate` | A phase is ready for review | yes |
| `budget` | The run budget is spent | yes |
| `qa_failed` | QA stopped after its failed rounds | yes |
| `paused`, `failed` | The run paused or failed (not a runner cooldown the doctor resumes, unless `cooldowns: true`) | yes |
| `incident` | The doctor opened an incident (info) or gave up on one (needs you) | on give-up |
| `change` | A change request opened or merged (info), or waits for a merge approval or a conflict fix (needs you) | on wait |
| `finished` | The run completed | no |
| `live` | The app is live. The message never has the demo password. | no |
| `stopped` | Ctrl+C, a dashboard stop, or a service restart. Off by default; add it to a channel's `events` to get it. | no |

Each channel can limit `events` and `projects`. Links go to the dashboard page for the event, from `dashboardUrl`. The links open the login page first when the dashboard has a login (see [Access](#access)).

### How it works

- The run never sends anything. A loop in `agent-team doctor` and in `agent-team ui` reads each project's event log every 15 seconds. A lock file (`.notify.lock`) lets only one of them send.
- The first pass starts after the latest event, so turning notifications on does not replay old events. Events older than 24 hours are skipped.
- The same stop is sent once per 6 hours. Informational messages are limited per project per minute (`throttle.perProjectPerMinute`). When more than `throttle.digestAfter` messages are due at once, you get one digest.
- A failed send is retried after 5 and 30 seconds, then dropped. After 5 failures in a row the channel turns off until the process restarts or `notifications.yaml` changes. The settings page shows the last error.
- The webhook body is the message as JSON. When `secret` is set, the `X-Agent-Team-Signature: sha256=<hex>` header holds an HMAC-SHA256 of the raw body.
- Email needs `nodemailer`, which is not installed by default: run `npm install nodemailer` in the agent-team folder.

### Secrets in the systemd service

Add the variables to the service's `EnvironmentFile` (mode 600), not to the unit file:

```sh
# ~/.config/agent-team/doctor.env
CLAUDE_CODE_OAUTH_TOKEN=...
AGENT_TEAM_SECRETS_KEY=...
NTFY_TOPIC_SUFFIX=...
NTFY_TOKEN=...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Secrets never go into `state.db`, the event log, the dashboard API, or git. The dashboard shows each channel's host only.

## Evals

The eval suite runs fixed reference briefs end to end, so you can tell whether a change to prompts, roles, or harness code made runs better, worse, or more expensive. The spec is in `docs/evals.md`.

```sh
node src/cli.ts eval run --tier smoke --label baseline
node src/cli.ts eval compare evals/results/<a>.json evals/results/<b>.json
```

| Tier | Briefs | Settings | Planned maximum spend |
| --- | --- | --- | --- |
| smoke | `landing-page`, `notes-api` | no branding, no marketing, 1 QA round, 2 parallel tasks | $34 |
| full | every brief in `evals/briefs/` | the settings in `pipeline.example.yaml` | sum of each brief's `budgetUsd` |

- Every brief runs in a fresh project under `evals/runs/<resultId>/`, one after another. Gates, deploy, and GitHub publishing are always off.
- Each brief's `budgetUsd` becomes its `budget.runUsd`. `--max-usd` caps the whole suite. The command shows the planned spend and asks before it starts, unless you pass `--yes`.
- The result goes to `evals/results/<resultId>.json`: outcome, merged tasks, attempts, fallbacks, reviewer rejections, QA rounds, cost, tokens, and wall time for each brief. `--clean` deletes the project folders afterwards.
- `eval compare` flags a regression when the outcome gets worse, a smaller share of tasks merges, or cost or tokens rise by more than 25%. It exits with 1 when it finds one.
- `--config <file>` replaces `pipeline.example.yaml` as the base, so you can compare two role or model setups.
- After each web brief, a design judge scores the QA screenshots from 0 to 100 on eight dimensions. `eval compare` flags a drop of more than 10 points. The `styled-landing` brief (full tier) runs the style catalog end to end. See [docs/design-styles.md](docs/design-styles.md).

## Limits

- Node's built-in `fetch` ignores `HTTPS_PROXY`, so app code that calls outside hosts with raw `fetch` fails inside the sandbox.
- With `isolation: none`, agents run with full access to the machine user. Use that only on a disposable VPS.

## Roadmap

Done: pipeline with parallel tasks, both runners, Docker sandbox, retries and fallbacks, network allowlist, scope guard at edit time, web dashboard with project creation and gates, branding and design system, QA gates, preview deploy, doctor, dashboard login, notifications, stack templates, change requests, eval suite.

Next:

1. Gate approvals from the phone (Telegram)
2. Eval full tier: four more briefs and a hidden acceptance check per brief

## License

MIT
