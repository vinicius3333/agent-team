# C002: Let QA and the preview log in, fail empty QA rounds, and keep lead access

## Change
QA could not open the preview. Every route (`/`, `/login`, `/new`, `/import`, `/incidents`, `/settings`) answered 403 on the QA host, because the `deploy.json` start command allows only the `APP_URL` host name. So the demo login never ran, and QA still passed the round because it filed the failures as "preexisting". Separately, saving the Lead settings on `/projects/:name` removes `access: full` from `pipeline.yaml`. This change fixes those four backlog items (#1, #2, #6, #3). It adds no features.

What must be true after the change:
- When the preview starts from `deploy.json`, the allowed host list holds the `APP_URL` host name, the names already in `AGENT_TEAM_UI_HOSTS`, and the host names QA and the preview use, all read from the environment. No host name is hard-coded.
- A `GET /` with the QA host header answers 200 with the "Log in" card. A `GET /` with an unknown host still answers 403.
- The demo login check fills the password field with `DEMO_PASSWORD`, submits, and sees the projects list without a timeout.
- A QA round where no page renders fails, even if its findings are marked "preexisting".
- Saving the Lead settings keeps `lead.access` and any other `lead` keys the form does not manage.

Three stories change: `US-02` (host list and demo login), `US-05` (QA verdict), and `US-06` (Lead settings). No new stories.

## New or changed user stories

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

## Out of scope
- Getting the app live and showing the **Live** badge (#4).
- Sprint mode and routines checks (#5).
- Any change to auth, sessions, or lockouts, and any loosening of the Host, Origin, `x-agent-team` header, or auth checks, for example allowing every host.
- Hard-coding the QA host name in `deploy.json` or the server.
- New features, or changes to any story other than `US-02`, `US-05`, and `US-06`.

## Open questions
- **Which environment variables hold the QA and preview host names?** The request says to read them from the environment but does not name them. Default: the architect finds the variables the QA and preview containers already set (for example a host name or container name variable) and adds those names to the list, alongside `APP_URL` and `AGENT_TEAM_UI_HOSTS`. Missing or empty values are skipped.
- **Does this contradict `US-02` as written in C001?** C001 said only the `APP_URL` host is allowed besides `AGENT_TEAM_UI_HOSTS`. Default: the request wins; `US-02` now also allows the QA and preview host names from the environment.
- **What counts as "no page rendered"?** Default: every route QA checked answered 403, 5xx, or no status, or showed no page content in its screenshot. One route that answers 200 with page content is enough to let the normal verdict stand.
- **Is the demo login bug only the host check?** Default: yes, but the hash step must also match `DEMO_PASSWORD` exactly. If the login still fails after the host fix, fix the hash step, not the login form.
- **Who can change the access level?** The request asks to show it in the form. Default: the form shows it as a choice (limited or full) that the operator can change and save, with limited as the default when `lead.access` is not set.
