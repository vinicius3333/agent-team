# agent-team

## Problem
Developers and small teams who want a working web app or API from an idea must still plan it, split the work, write the code, review it, and test it by hand. agent-team is a self-hosted orchestrator that does this with a team of scoped AI agents. The agents turn a plain-text product brief into a spec, an architecture, a design, a task plan, built and reviewed code, QA results, and an optional live preview. The operator keeps control through approval gates, budgets, and a web dashboard, and pays only for the agent runs on their own server.

## Users
- **Visitor:** a developer who finds the public marketing site and decides whether to install agent-team.
- **Operator:** a developer who hosts the dashboard, creates or imports projects, and steers runs at gates and decisions.
- **Maintainer of a live app:** an operator who keeps a finished project going with change requests, backlog items, sprints, and findings.
- **Admin:** the person who sets up the login (password hash and session secret, or a trusted auth proxy), the git identity, and notifications on the server.

## User stories

### US-01: Learn about agent-team on the landing page
As a visitor, I want a public page at `/` of the marketing site that explains what agent-team does so that I can decide whether to install it.

Acceptance criteria:
- Opening `/` on the marketing site without logging in shows the heading "From a paragraph to a pull request." and a sentence that says agent-team turns a plain-text brief into a tested web app with a team of AI agents.
- The page shows the sections "How it works" (`#pipeline`), "Control" (`#control`), "Self-hosted" (`#runners`), and an install section (`#install`), and the header links jump to each one.
- Clicking **Install agent-team** in the hero scrolls to `#install`, and clicking **Star on GitHub** opens `https://github.com/vinicius3333/agent-team`.
- The page has no sign-up form; its main call to action leads to the install instructions.

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

### US-03: Create a project from a brief and start a build
As an operator, I want to type a product brief in a form and start a build so that the agent team plans and builds the app for me.

Acceptance criteria:
- On `/new`, the form has fields for project name, product brief, target (web, API, or both), stack (Custom or a stack template for the target), worker provider (Claude or Codex), approval gates, agent models, **Create GitHub repo**, **Deploy when ready**, and **Branding**.
- Submitting with an empty brief shows "Describe what you want to build." and does not create a project.
- The project name accepts only lowercase letters, digits, and dashes; any other name shows an error and does not create a project.
- Submitting a valid form creates the project, starts a run, shows the toast "Started <name>", and opens the project page.
- The new project appears in the list on `/`, together with every other project on the server.

### US-04: Import an existing project
As an operator, I want to import an existing repository or folder so that the team can document it and take change requests on it.

Acceptance criteria:
- On `/import`, I choose a git URL or a local folder, a project name, a GitHub mode (Source repo, New repo, or None), approval gates (spec, architecture, design), and whether to deploy changes.
- An empty source shows "Paste the repository URL." for git or "Type the folder's full path." for a folder, and a folder path that does not start with `/` shows "Use the full path, starting with /."
- Choosing **Source repo** with a non-GitHub URL shows "Only a GitHub URL can use the source repo for pull requests."
- Submitting a valid form shows the toast "Importing <name>" and starts the importer, PM, architect, designer, and baseline steps; the source folder itself is not changed.

### US-05: Follow a run and steer it at gates and decisions
As an operator, I want to see a run's progress and answer the points where it stops so that the build keeps going the way I want.

Acceptance criteria:
- The project page at `/projects/:name` shows the pipeline phases, the tasks, live events, cost, and elapsed time, and updates without a reload while the run is active.
- When a phase waits at a gate, the page shows its output with **Approve** and **Request changes**; approving continues the run, and requesting changes with notes makes the agent redo that phase with the notes.
- When a worker asks for more files, the page shows a card with the files and the buttons **Approve and retry** and **Reject**; rejecting drops the task.
- When the run stops, a banner shows the reason and the key error lines, and **Resume run** starts it again.
- When the run hits its budget, a budget banner shows **Raise budget and resume**, which adds 50% to `budget.runUsd` and resumes the run.
- The QA tab shows findings, test output, and each screenshot; when the app is live, the page shows a **Live** badge and the preview URL.
- When every checked route in a QA round fails (for example all answer 403 or 5xx, or no page renders), the round's verdict is "fail" with the message "No page rendered. Check the host and start command.", even if the reviewer says "pass" or marks the failures "preexisting". A test in `test/qa.test.ts` covers this case and a case where at least one route renders.

### US-06: Ask the project lead about a run
As an operator, I want to chat with a lead agent about my project so that I can understand a problem and fix it quickly.

Acceptance criteria:
- In the **Lead** tab, I type a question and get an answer that uses the project's state, docs, and transcripts.
- When the lead suggests an action (for example retry or resume), clicking it applies the action; the lead never changes the project without that click.
- I can stop a chat reply that is still running, and chat cost is not added to the run budget.
- The Lead settings form on `/projects/:name` shows the access level, limited or full, with one sentence that says what full access allows.
- Saving the Lead settings with access set to full leaves `access: full` under `lead` in `pipeline.yaml`; saving with limited writes `access: limited`. Other `lead` keys the form does not manage stay unchanged. A round-trip test checks this.

### US-07: Change a finished app
As a maintainer, I want to send change requests, add backlog items, review findings, and start sprints so that the app keeps improving after the first build.

Acceptance criteria:
- Submitting a change request on a project starts a change run on the existing app; I can later merge or abandon that change.
- Adding a backlog item creates an open finding for the project.
- For each open finding, **Approve** marks it approved and **Dismiss** marks it dismissed, and the findings list can be filtered by open, approved, dismissed, or all.
- Starting a sprint or a cleanup creates a run from the approved work, and the sprints list shows it.
- Running the operate (insight) agents adds their findings to the project's findings list.

### US-08: Review incidents the doctor handled
As an operator, I want to see the runs that the doctor diagnosed and tried to repair so that I know what broke and what it did.

Acceptance criteria:
- `/incidents` lists incidents across projects, newest first, under the heading "Incidents".
- Opening `/incidents/:project/:id` shows the incident's details and the doctor's diagnosis, or "The doctor has not answered yet." when there is none.

## Out of scope
- Public sign-up or self-service accounts. The dashboard has one shared password or relies on a trusted auth proxy; there are no user accounts, roles, or per-user permissions.
- Password reset or change from the dashboard. The admin sets the password hash with `hash-password` and restarts the server.
- Hosted or multi-tenant service. Each operator runs their own server.
- Payments, paid plans, or billing inside agent-team. Agent cost is tracked per run against `budget.runUsd` only.
- Product analytics on the dashboard or the marketing site.
- A login link or dashboard access from the marketing site.
- Choosing agent runners other than the supported `claude` and `codex` CLIs.
- CI for the server tests, the typecheck, or the dashboard build (only `site/` is built in CI today).
- The CLI is a second way to do everything above; this spec does not list separate stories for it.

## Open questions
- **Is the marketing site the product's landing page?** The dashboard's `/` is the projects list behind the login, so it cannot explain the product to a new visitor. Default: `US-01` describes the `site/` page at `/` on GitHub Pages. Its public URL is not in `input.md` or the code I read.
- **Is `agent-team.137-131-153-58.sslip.io` still the live production dashboard?** Default: treat it as the production instance named in `docker-compose.yml`; I did not open it.
- **Which features are not covered by a story?** Settings (git identity, notifications, browser preferences), project config edits (gates, roles, lead settings, auto-approve scope), file and transcript browsing, branding and mockup views, and the `doctor` service all exist today. Default: they are part of the app as it is, but this spec does not describe them in detail to keep to 8 stories.
- **Exact behavior of change requests, sprints, cleanups, and operate agents.** I took these from the API routes, the README, and `docs/change-requests.md`, `docs/sprints.md`, and `docs/operate.md`, not from running them. Default: they behave as those docs describe.
- **Plans in `docs/payments.md` and `docs/plans/`.** Default: treat them as not built, since the dashboard shows no payments or plans.
- **Global lockout.** The README says 30 wrong passwords from any address lock all logins for 15 minutes. Default: this is true, but `US-02` tests only the per-address lockout.
- **Do `npm test` and `npm run typecheck` pass on `main`?** No CI runs them. The import baseline found that `npm test` failed. Default: change C001 makes `npm test` pass offline.
- **How does the demo account log in?** The dashboard has no users, so `DEMO_EMAIL` is unused. Default (C001): the login check uses `DEMO_PASSWORD` alone on the password-only card.
- **Which host names does the preview allow?** Default (C002): the `APP_URL` host, the names in `AGENT_TEAM_UI_HOSTS`, and the QA and preview host names read from the environment. No host name is hard-coded.
- **What is the default lead access?** Default (C002): limited when `lead.access` is not set in `pipeline.yaml`.
- **Who uses it?** Real usage is unknown beyond the author. Default: the main user is a single developer who self-hosts it.
