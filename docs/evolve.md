# Evolve and learning

Two loops keep the harness improving. They do not need a person.

| Loop | Scope | Role | Output |
| --- | --- | --- | --- |
| Evolve | One project | `evaluator` | A score, the gaps, and the tasks that close them |
| Learning | Every project in the runs folder | `curator` | Lessons that go into the agents' system prompts |

## Evolve

The loop runs after QA passes and the app is deployed. It needs `deploy.enabled: true` and does not run while a change request is open.

```yaml
evolve:
  enabled: true
  targetScore: 90      # 0 to 100
  maxCycles: 0         # 0 = no limit
  cycleBudgetUsd: 25   # a cycle starts only when this much of budget.runUsd is left
```

Each cycle:

1. **Check the budget.** When less than `cycleBudgetUsd` of `budget.runUsd` is left, the run stops as a budget stop. The dashboard offers **Raise budget and resume**.
2. **Evaluate.** The evaluator reads the brief (`input.md`), the spec, the code, and the screenshots of the last QA round. It also reads the user's chat messages, the open Operate findings, and the previous evaluation. It scores five dimensions: `brief_coverage`, `functionality`, `monetization`, `ux_and_branding`, and `quality_and_reliability`. The orchestrator takes their mean as the score. The result goes to `.agent-team/evaluations/cycle-<n>.json`, and the meta keys `evolve.cycle` and `evolve.score` are updated.
3. **Learn.** The curator runs (see below).
4. **Decide.** At or above `targetScore`, the loop ends. With no tasks, it also ends.
5. **Build.** The tasks (at most 6, ids `E<cycle><nn>`) are added to `tasks.json`. QA and deploy go back to pending. The tasks are built, QA runs (with fix rounds as usual), and the app redeploys. Then the next cycle starts.

A stopped run resumes where it stopped. Pending tasks are built, QA and deploy run, and the next cycle evaluates again.

"Never stops" has limits: the loop stops at the target score, when it has nothing to build, at `maxCycles`, or at the budget. Set `budget.runUsd` to the most you are willing to spend. The doctor resumes runs that crash or stall.

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
- **Curator.** After every run that stopped with 3 or more new signals, after every finished run, and in every evolve cycle, the `curator` role groups the signals by root cause. It then confirms, adds, or retires lessons. It aims each lesson at the earliest role that can prevent the problem.
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
