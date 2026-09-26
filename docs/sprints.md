# Sprints and learning

Two loops keep the harness improving. They do not need a person.

| Loop | Scope | Roles | Output |
| --- | --- | --- | --- |
| Sprints | One project | `evaluator`, `pm` | A score, backlog items, and one change request per sprint |
| Learning | Every project in the runs folder | `curator` | Lessons that go into the agents' system prompts |

## Sprints

Once the app is live, the doctor starts a sprint on a fixed schedule. Each sprint evaluates the app, refines the backlog, and ships the chosen items as one [change request](change-requests.md). Sprints replace the evolve loop.

```yaml
sprints:
  enabled: true
  everyDays: 7       # days from the end of one sprint to the start of the next
  budgetUsd: 25      # the most one sprint may spend
  monthlyUsd: 100    # the most all sprints of the last 30 days may spend together
  maxItems: 5        # backlog items per sprint
  newFeatures: true  # the PM may propose features the brief does not ask for
```

Sprints need `deploy.enabled: true` and a running doctor (`agent-team doctor <runsDir>`).

To change these settings from the dashboard, open **Operate > Sprints** and click **Sprint settings**. The dialog writes the whole `sprints:` block and commits `pipeline.yaml`. It removes a legacy `evolve:` block, because `sprints:` overrides it. The doctor reads the file on every tick, so a new interval moves the next due time at once.

### The backlog

The backlog is the list of open findings. Four sources feed it:

| Source | Who writes it | When |
| --- | --- | --- |
| `monitoring`, `analytics`, `research` | The Operate agents | On their own schedules (see [Operate](operate.md)) |
| `evaluator` | The evaluator | Each sprint: every gap in the app becomes an item |
| `product` | The PM | Each sprint, when `newFeatures` is on: at most 2 new feature ideas |
| `manual` | You | Any time: **Add item** on the Backlog view, or `agent-team backlog <dir> --add "<title>" [--detail <text>] [--severity high\|medium\|low]` |

An item with the same source and title as an open item updates that item instead of adding a copy.

### Start picked items without a sprint

You do not have to wait for the next sprint. On the Backlog view, tick the open items you approve, then press **Start development** in the bar that shows "N selected". The dashboard opens one [change request](change-requests.md) for all of them and starts the run. The request lists each item's title and proposal, then a `Backlog items:` trail, so the change keeps its link to the backlog. Each item turns `approved` with the change id.

You can pick up to 20 items at once. The button is off while a run is active. If any item is unknown or no longer open, or a change is already open, nothing changes. The API route is `POST /api/projects/:name/findings/approve` with `{ "ids": [...] }`.

### When a sprint starts

The doctor checks every project once a minute. It starts a sprint when all of these hold:

- `sprints.enabled` and `deploy.enabled` are on
- no run is alive, no change is open, and the last build finished (QA passed and deployed)
- no sprint is in progress
- `everyDays` passed since the last sprint ended (6 hours after a failed sprint)
- the sprints of the last 30 days spent less than `monthlyUsd - budgetUsd`

The first sprint starts as soon as the first build is live. **Start sprint now** on the Sprints view, or `agent-team sprint <dir> --now`, skips the wait; the other rules still apply.

### What a sprint does

The doctor starts `agent-team sprint <dir>` as a detached run, like any other run.

1. **Budget.** When `budget.runUsd` leaves less than `budgetUsd` of room, the run raises it to the project cost plus `budgetUsd` and commits `pipeline.yaml`. The regular budget stop then caps the sprint.
2. **Evaluate.** The evaluator reads the brief, the spec, the code, the screenshots of the last QA round, the chat, and the previous evaluation. It scores five dimensions (`brief_coverage`, `functionality`, `monetization`, `ux_and_branding`, `quality_and_reliability`); the score is their mean. The result goes to `.agent-team/evaluations/sprint-<n>.json`, and each gap joins the backlog. A failed evaluation does not stop the sprint.
3. **Plan.** The `pm` role, with `prompts/sprint-planner.md`, picks one goal and up to `maxItems` backlog items and proposals. It ranks broken core flows first, then your own items and chat requests, then evaluator gaps, then data, then competitor ideas. It dismisses items that are done or stale, with a reason.
4. **Open the change.** The request is the PM's text, headed `Sprint <n>: <goal>` and followed by the list of item ids. The picked items move to `approved` with the change id.
5. **Ship.** The same run goes on as a change request: spec, architecture, and plan deltas, build, QA, merge into `main`, and redeploy. Gates and `autonomy.changeMerge` apply as for any change.
6. **Close.** The sprint is `done` when its change merges, and `abandoned` when the change is abandoned. Its cost is the growth of the project cost since the sprint started.

A sprint with nothing worth building is `skipped`. A sprint whose planning fails (a runner outage, no usable plan) is `failed` and tries again 6 hours later, without an incident. When the build part of a sprint stops, the doctor handles it like any stopped run.

### Commands and views

- `agent-team sprints <dir>`: the sprint history.
- `agent-team backlog <dir>`: the open backlog.
- The dashboard's **Operate > Sprints** view has **Sprint settings** and shows the next due time, the 30-day spend, the score trend, the active sprint with its picked items, and the history. **Operate > Backlog** lists the items by source and has **Add item**.

### Projects from before sprints

A `pipeline.yaml` with an `evolve:` block and no `sprints:` block keeps working: `evolve.enabled` turns sprints on, and `evolve.cycleBudgetUsd` becomes `sprints.budgetUsd`. `targetScore` and `maxCycles` are ignored. Earlier `cycle-<n>.json` evaluations still count as the previous evaluation.

## Learning

```yaml
learning:
  enabled: true
  maxLessonsPerRole: 12
```

- **Signals.** These are the files the run wrote since the last curation:
  - rejected attempts (`.agent-team/attempts/*.diff` headers)
  - QA verdicts
  - evaluations
  - incident diagnoses
- **Curator.** After every run that stopped with 3 or more new signals, and after every finished run (sprints included), the `curator` role groups the signals by root cause. It then confirms, adds, or retires lessons. It aims each lesson at the earliest role that can prevent the problem.
- **Store.** Lessons go to `<runs folder>/.agent-team-lessons/lessons.json`. Set `AGENT_TEAM_LESSONS` to use another file. A new store starts with the lessons from the first long project, a secret-santa web app.
- **Use.** `runAgent` adds the `maxLessonsPerRole` strongest lessons for the role to the end of its system prompt. The weight is `hits × 0.5^(days since last seen / 30)`.
- **Safety.** Learning never stops a run. Errors are logged under the `learning` event kind, and the agent call goes ahead without lessons.

### Standard knowledge

`knowledge/seed-lessons.json` holds about 50 lessons paraphrased from public standards:

| Area | Sources |
| --- | --- |
| Security | OWASP Cheat Sheets, OWASP Top 10 |
| Accessibility | WCAG 2.2 |
| Performance | web.dev Core Web Vitals |
| Operations | The Twelve-Factor App |
| Frameworks | Next.js docs, react.dev |
| Testing | Testing Library, Martin Fowler |
| Payments | Stripe docs |
| UX | Nielsen Norman Group, plainlanguage.gov |
| Brazil | MDN `Intl` (BRL and dates), LGPD |

Each entry has a stable id (`K-<slug>`), roles, stack tags, the source URL, the license, and `checkedAt`.

- **Loading.** Every lesson store gets the standard lessons it does not have yet, so a lesson added to the file reaches existing runs folders. A lesson the curator retires is recorded in `retired.json` and does not come back.
- **Ranking.** Standard lessons start at weight 1. Lessons learned from real failures start at 2 or more, so they rank first when a role has more lessons than `maxLessonsPerRole`.
- **Licenses.** Rules are paraphrased in one sentence and link their source. Never paste text from the sources. OWASP and MDN are CC BY-SA, and Stripe and NN/g are copyrighted.
- **Upkeep.** Run `node scripts/check-knowledge.ts --write` about once a month. It checks that each source still answers and sets `checkedAt`. A failing source needs a person to check the lesson.
- **Next.js.** The `K-next-bundled-docs` lesson points agents to the docs that ship with the installed version (`node_modules/next/dist/docs/`), as Next.js recommends. It does not copy API rules that go stale.

### Stack tags

Each lesson has `stacks`. These are npm package names such as `next` or `better-sqlite3`, or a language tag such as `python`, `go`, or `rust`. An empty list means the lesson holds on any stack.

A project's tags come from its `package.json` dependencies, plus a language tag for non-Node projects. An agent gets a lesson only when the lesson has no tags or shares a tag with the project. Before the scaffold exists, the project has no tags, so every lesson applies. The curator sets the tags.

### Solution memory

```yaml
learning:
  memory: true
  maxSimilarTasks: 2
```

- **Record.** Every merged task goes into `<runs folder>/.agent-team-lessons/memory.db`, a SQLite file with an FTS5 search index. Each entry holds the project, the task, its acceptance criteria, the changed files, the worker's summary, the diff (capped at 12 KB), and the stack tags.
- **Search.** Before each worker attempt, the orchestrator searches the memory with the task's title, acceptance criteria, and paths. It uses BM25, where title matches weigh most. Tasks from the same project are left out, because the worker already sees that code. Solutions that share a stack tag besides `node` come first.
- **Use.** The worker's task prompt gets a "Similar tasks from earlier projects" section. It holds the `maxSimilarTasks` best matches, each with its summary and up to 4 KB of diff.
- **Backfill.** `node scripts/backfill-memory.ts <runsDir>` indexes projects built before the memory existed. It reads `docs/progress.md`, the acceptance criteria in `tasks.json`, and the diff of each task's pull request merge (or its `feat(<id>)` commits). It is safe to run again: each task replaces its earlier entry.
- **Why keywords, not vectors.** Keyword search needs no embedding provider, no extra key, and no new domain in the proxy allowlist. If it misses relevant matches, only `searchSolutions` in `src/memory.ts` changes.

You can edit the lessons file by hand, for example to delete a bad lesson. Write it while no curator is running.
