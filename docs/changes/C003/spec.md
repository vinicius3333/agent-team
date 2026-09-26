# C003: Reliable resume, a published image, GitHub issue intake, working sprints and deploy, and custom model endpoints

## Change
This change handles seven backlog items (#10, #8, #7, #5, #4, #11, #9). Two of them fix things the user asked for before that still do not work: sprints and routines on this project (#5), and the live deploy (#4). The rest make the app easier to run and feed: resume a run without a container name clash (#10), keep sessions across a redeploy (#11), install with one `docker run` (#8), turn labeled GitHub issues into work (#7), and let the Codex runner use any OpenAI-compatible endpoint (#9).

What must be true after the change:
- Resuming a run whose old container still exists removes that container and waits until it is gone before it starts a new one.
- Each GitHub release builds the `Dockerfile` and pushes the image to `ghcr.io`. The site's install section starts with a `docker run` of that image.
- For a project with a GitHub repo, open issues with the `agent-team` label become backlog items (or change requests), and each issue gets a comment that links to its item.
- On this project, starting a sprint from approved findings and running a routine both work, and both show up in the sprints list.
- With `deploy.enabled: true`, the app deploys: the project page shows the **Live** badge and a preview URL that answers.
- The `deploy.json` start command sets `AGENT_TEAM_UI_SESSION_SECRET` from a stored secret, so a login survives a redeploy.
- `pipeline.yaml` can give the Codex runner a base URL and an API key, so it can call OpenRouter, vLLM, Ollama, or a similar server.

Five stories change: `US-01` (install step), `US-02` (session secret), `US-03` (model endpoint), `US-05` (resume and deploy), and `US-07` (issue intake, sprints, and routines). No new stories.

## New or changed user stories

### US-01: Learn about agent-team on the landing page
As a visitor, I want a public page at `/` of the marketing site that explains what agent-team does so that I can decide whether to install it.

Acceptance criteria:
- Opening `/` on the marketing site without logging in shows the heading "From a paragraph to a pull request." and a sentence that says agent-team turns a plain-text brief into a tested web app with a team of AI agents.
- The page shows the sections "How it works" (`#pipeline`), "Control" (`#control`), "Self-hosted" (`#runners`), and an install section (`#install`), and the header links jump to each one.
- Clicking **Install agent-team** in the hero scrolls to `#install`, and clicking **Star on GitHub** opens `https://github.com/vinicius3333/agent-team`.
- The page has no sign-up form; its main call to action leads to the install instructions.
- The first step in `#install` is a `docker run` command that uses the image `ghcr.io/vinicius3333/agent-team`, with a copy button. The steps after it still show the other ways to install.
- A GitHub Actions workflow runs when a release is published. It builds the repo's `Dockerfile` and pushes the image to `ghcr.io/vinicius3333/agent-team` with the release tag and `latest`. A test or a lint check confirms the workflow file names that image and the `release` trigger.

### US-02: Log in to the dashboard
As an operator, I want to log in with the dashboard password so that only people I trust can start paid agent runs and read project files.

Acceptance criteria:
- When a password hash is set and I am not logged in, every dashboard URL shows the "Log in" card with a password field, and every `/api` route except `/api/auth/*` returns 401.
- Submitting the right password sets an HttpOnly session cookie and shows the page I asked for.
- Submitting a wrong password shows "Wrong password." and keeps me on the login card.
- After 5 wrong passwords from one address, login from that address is locked for 15 minutes, and the card shows "Too many tries. Try again in N minutes."
- When no login is set and the server listens on loopback only, the dashboard opens with no login card.
- When a trusted proxy sends the configured user header from an allowed IP, the dashboard treats that user as logged in.
- When the preview starts with `APP_URL` set, a page request whose host is the `APP_URL` host answers 200 and shows the "Log in" card; a request with any other unknown host answers 403 with "This host name is not allowed. Add it to AGENT_TEAM_UI_HOSTS."
- When the preview starts from `deploy.json`, the allowed host list is built from the environment: the names in `AGENT_TEAM_UI_HOSTS`, the `APP_URL` host name, and the QA and preview host names the environment provides. Given a QA host such as `agent-team-qa-agent-team` in that environment, a `GET` on `/`, `/login`, `/new`, `/import`, `/incidents`, and `/settings` with that host answers 200. A test checks the built list for a set of example environments, including empty values and duplicates.
- When the preview starts with `DEMO_PASSWORD` set (12 or more characters), the baseline login check opens `/`, fills the password field with `DEMO_PASSWORD`, submits, and sees the projects list; it does not wait for an email field and does not time out.
- The password hash the start command builds from `DEMO_PASSWORD` accepts exactly `DEMO_PASSWORD` on the login form, with no extra newline or space.
- The `deploy.json` start command sets `AGENT_TEAM_UI_SESSION_SECRET` from a stored deploy secret. The secret is made once with `agent-team session-secret` and is not written in `deploy.json` itself. A test checks that the start command reads the secret and that the value is not in the file.
- After a redeploy that keeps the stored secret, a session cookie issued before the redeploy still opens the projects list without the "Log in" card.

### US-03: Create a project from a brief and start a build
As an operator, I want to type a product brief in a form and start a build so that the agent team plans and builds the app for me.

Acceptance criteria:
- On `/new`, the form has fields for project name, product brief, target (web, API, or both), stack (Custom or a stack template for the target), worker provider (Claude or Codex), approval gates, agent models, **Create GitHub repo**, **Deploy when ready**, and **Branding**.
- Submitting with an empty brief shows "Describe what you want to build." and does not create a project.
- The project name accepts only lowercase letters, digits, and dashes; any other name shows an error and does not create a project.
- Submitting a valid form creates the project, starts a run, shows the toast "Started <name>", and opens the project page.
- The new project appears in the list on `/`, together with every other project on the server.
- When `pipeline.yaml` sets a base URL and an API key source for the Codex runner, a Codex agent run calls that base URL with that key. A test with a fake runner checks that both values reach the Codex command, and that the key never appears in logs or run events.
- When `pipeline.yaml` sets no base URL, the Codex runner works as before.
- A base URL that is not an `http://` or `https://` URL stops the run before any agent starts, with the error "Set codex base URL to a full http or https URL."

### US-05: Follow a run and steer it at gates and decisions
As an operator, I want to see a run's progress and answer the points where it stops so that the build keeps going the way I want.

Acceptance criteria:
- The project page at `/projects/:name` shows the pipeline phases, the tasks, live events, cost, and elapsed time, and updates without a reload while the run is active.
- When a phase waits at a gate, the page shows its output with **Approve** and **Request changes**; approving continues the run, and requesting changes with notes makes the agent redo that phase with the notes.
- When a worker asks for more files, the page shows a card with the files and the buttons **Approve and retry** and **Reject**; rejecting drops the task.
- When the run stops, a banner shows the reason and the key error lines, and **Resume run** starts it again.
- When I resume a run and a container with that run's name still exists but its run is no longer alive, the app removes that container with `docker rm -f`, waits until `docker inspect` no longer finds it, and only then calls `docker run`. A case in `test/run-container.test.ts` checks this order with a fake `docker`.
- When the run hits its budget, a budget banner shows **Raise budget and resume**, which adds 50% to `budget.runUsd` and resumes the run.
- The QA tab shows findings, test output, and each screenshot; when the app is live, the page shows a **Live** badge and the preview URL.
- When `pipeline.yaml` has `deploy.enabled: true` and a run or sprint finishes, the app is deployed: the project page shows the **Live** badge, a `GET` on the preview URL answers 200, and the sprint report does not say "The live app: not deployed".
- When the deploy is enabled but fails, the sprint report and the project page say why in one sentence and what to do next, instead of "not deployed" with no reason.
- When every checked route in a QA round fails (for example all answer 403 or 5xx, or no page renders), the round's verdict is "fail" with the message "No page rendered. Check the host and start command.", even if the reviewer says "pass" or marks the failures "preexisting". A test in `test/qa.test.ts` covers this case and a case where at least one route renders.

### US-07: Change a finished app
As a maintainer, I want to send change requests, add backlog items, review findings, and start sprints so that the app keeps improving after the first build.

Acceptance criteria:
- Submitting a change request on a project starts a change run on the existing app; I can later merge or abandon that change.
- Adding a backlog item creates an open finding for the project.
- For each open finding, **Approve** marks it approved and **Dismiss** marks it dismissed, and the findings list can be filtered by open, approved, dismissed, or all.
- Starting a sprint or a cleanup creates a run from the approved work, and the sprints list shows it.
- On this project (agent-team), starting a sprint from approved findings creates a run that reaches a final state, and the sprint shows in the sprints list with that state.
- On this project, running a routine by hand (`agent-team routines <projectDir> --run <id>` or the dashboard) finishes, records its last run, and its output (findings or a sprint) shows in the findings list or the sprints list.
- Running the operate (insight) agents adds their findings to the project's findings list.
- For a project with a GitHub repo, the app polls open issues that carry the `agent-team` label. Each new labeled issue becomes one open backlog item with the issue's title, body, and link.
- After it adds the item, the app comments once on the issue with a link to the item. Polling again does not add a second item or a second comment for the same issue. A test with a fake GitHub checks both.
- A project with no GitHub repo does not poll issues.

## Out of scope
- Turning issues into change requests that start on their own. Every labeled issue becomes a backlog item; the maintainer approves it or starts a change by hand.
- Closing, relabeling, or syncing the status of a GitHub issue after the first comment.
- GitHub webhooks for issues. v1 polls.
- Labels other than `agent-team`, and issues from repos other than the project's own repo.
- Images on registries other than `ghcr.io`, and image builds for each commit or pull request. Only releases publish an image.
- CI for the server tests, the typecheck, or the dashboard build. The new workflow only builds and pushes the image.
- Custom model endpoints for the Claude runner. Only the Codex runner gets a base URL.
- A form on `/new` or `/settings` for the base URL and key. They are set in `pipeline.yaml` and the environment only.
- Rotating the session secret from the dashboard.

## Open questions
- **Backlog item or change request for a labeled issue?** The request says "change request or backlog item". Default: a backlog item (an open finding), so nothing costs money until the maintainer approves it.
- **How often does issue polling run?** Default: every 10 minutes while the server runs, and the interval can be set in `pipeline.yaml`.
- **Which link goes in the issue comment?** Default: the finding's link on the dashboard, built from `APP_URL`. When `APP_URL` is not set, the comment names the project and the item number instead.
- **Where does the Codex API key live?** A key in `pipeline.yaml` would be a committed secret. Default: `pipeline.yaml` holds the base URL and the name of the environment variable that holds the key; the key itself stays in the environment.
- **Where is the session secret stored?** Default: with the other deploy secrets, outside the repo. The architect picks the exact place.
- **Why do sprints, routines, and deploy fail today?** The request says they do not work, but not why. Default: the fix is done when the checks in `US-05` and `US-07` pass on this project, whatever the cause turns out to be.
- **Does the image name match the repo?** Default: `ghcr.io/vinicius3333/agent-team`, taken from the GitHub URL in `input.md`.
- **Contradiction:** the spec listed CI as out of scope. This change adds one CI workflow that builds and pushes the image on release. Default: keep the request; other CI stays out of scope.
