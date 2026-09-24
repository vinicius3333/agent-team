# Evals: spec

An eval suite runs a fixed set of reference briefs end to end and records how the pipeline did on each one. Use it to tell whether a change to prompts, roles, or harness code made runs better, worse, or more expensive. Read `src/cli.ts`, `src/pipeline.ts` (`runPipeline`, `RunOutcome`, `RunStop`), `src/project.ts` (`createProject`, `openProjectStore`), `src/config.ts` (`loadConfig`), `src/store.ts` (`attempts`, `reviews`, `tasks`, `phases`, `meta`), `src/qa.ts` (`runQaLoop`), and `test/task-loop.test.ts` first.

Rules for all items: match the repo style (no semicolons, double quotes, erasable TS, `.ts` imports); add tests with stubs; keep `npx tsc --noEmit`, `npm test`, and `npm run build:ui` passing; log every automatic decision as an event. The suite reads project stores; it never changes pipeline behavior.

## Briefs

- Briefs live in `evals/briefs/<id>/`: `brief.md` (the text `createProject` takes) and `eval.yaml`.
- `eval.yaml` holds: `tier` (`smoke` or `full`), `target` (web | api | web+api), optional `pipeline` overrides merged over the suite config, `budgetUsd` (hard cap for this brief), and `timeoutMinutes`.
- Start with 6 briefs: 2 smoke (a static landing page; a JSON API with 3 endpoints) and 4 full (CRUD web app with login, web+api todo app with tests, a dashboard with charts, a form-heavy app). Keep each brief under 40 lines so the plan stays small.
- Briefs are versioned with the code. A change to a brief changes its `briefHash`, and `eval compare` refuses to compare results with different hashes unless given `--allow-brief-change`.

## CLI

```
agent-team eval run [--tier smoke|full] [--brief <id>]... [--config <file>] [--label <name>] [--out <evalsDir>]
agent-team eval compare <resultA> <resultB>
agent-team eval compare --rev <gitRevA> --rev <gitRevB> [--tier smoke]
```

- `eval run` runs the selected briefs one after another (not in parallel, see Isolation) and writes one result file. Exit code 0 when every brief completed, 1 otherwise.
- `eval compare` prints a table per brief and a total row: tasks merged, attempts, cost, tokens, wall time, QA rounds, reviewer rejections, outcome. It marks a regression when the outcome gets worse, cost or tokens rise more than 25%, or merged tasks drop.
- Add the `eval` case in `main()` in `src/cli.ts`. `parseArgs` needs `multiple: true` for `--brief` and `--rev`.

## Headless run

- The suite config forces `autonomy.gates: []`. Gates are already optional (`runPlanningPhase` only stops when the phase is in `config.autonomy.gates`), so no auto-approve code is needed.
- It also forces `publish.github.enabled: false` and `deploy.enabled: false` unless the brief sets them. Deploy exposes a public tunnel; evals should not.
- A brief's run calls the same code as `run()` in `src/cli.ts`: `createHarness`, `createGitHub`, `runPipeline`. Extract that body into `runProject(projectDir, signal)` in `src/project.ts` (or a new `src/run.ts`) so both `run` and `eval` use it.
- Stops that need a human (`awaiting_approval` from a budget stop or a replan escalation) end that brief. Record the outcome and the `run.stop` reason; do not retry.
- `paused` from a runner cooldown: resume up to 2 times after the cooldown, then record `paused`. Count the waits in wall time separately (`waitMs`) so rate limits do not look like slow runs.

## Isolation

- Each brief gets a fresh project dir: `<evalsDir>/runs/<resultId>/<briefId>/`, created with `createProject`. Nothing is shared between briefs except the runner logins.
- Use `harness.isolation: docker` by default, same as production. Allow `none` for a local smoke run.
- Run briefs in sequence. Parallel briefs would share rate limits and skew wall time and fallback counts. Parallelism inside one brief (`parallelTasks`) stays as configured.
- `--rev` runs check out each revision into a git worktree under `<evalsDir>/revs/<sha>/` and run that revision's `src/cli.ts eval run`. The orchestrator code under test is never the code running the comparison.

## Result storage

One JSON file per suite run: `<evalsDir>/results/<resultId>.json`, where `resultId` is `<utc timestamp>-<short sha>[-<label>]`. Keep project dirs so transcripts can be inspected; `eval run --clean` deletes them after writing the result.

```json
{
  "resultId": "20260924T101500Z-dcc28f7-baseline",
  "gitSha": "dcc28f7", "dirty": false, "label": "baseline",
  "configHash": "…", "config": { "roles": { … }, "harness": { … } },
  "tier": "smoke",
  "briefs": [{
    "id": "landing-page", "briefHash": "…",
    "outcome": "completed", "stop": null,
    "phases": { "spec": "approved", "plan": "approved", "qa": "approved" },
    "tasks": { "total": 6, "merged": 6, "blocked": 0, "replans": 0 },
    "attempts": { "total": 21, "byRole": { "worker": 8, "reviewer": 8 }, "fallbacks": 0 },
    "reviews": { "total": 8, "fail": 2 },
    "qa": { "rounds": 1, "verdict": "pass", "fixTasks": 0 },
    "costUsd": 4.12, "unreportedCalls": 0, "tokens": 812000,
    "wallMs": 1830000, "waitMs": 0
  }]
}
```

Where each field comes from:

| Field | Source |
|---|---|
| outcome, stop | return value of `runPipeline`; `meta run.stop` |
| phases | `store.phases()` |
| tasks | `store.tasks()`: status and `replans` |
| attempts, fallbacks | `attempts` table grouped by role; a fallback is a row whose runner/model is not the role's primary |
| reviews | `reviews` table: count and `verdict = 'fail'` |
| qa | `qa` phase status, `Q<round><n>` task ids, QA round events |
| costUsd, unreportedCalls | `store.projectCost()` |
| tokens | `SUM(tokens)` from `attempts` (new store method) |
| wallMs | clock around `runProject` |

Add `store.evalSummary()` in `src/store.ts` that returns the store-backed fields in one call, so the eval code does not write SQL.

## Comparing revisions and configs

- Two result files: `eval compare a.json b.json`. It warns when `configHash` differs and prints the changed config keys, so a role/model change is visible.
- Two git revisions: `eval compare --rev A --rev B` runs `eval run` at each revision with the same `--config` and tier, then compares. It refuses a dirty worktree for the current revision.
- Two configs at one revision: run `eval run --config a.yaml --label a` and `--config b.yaml --label b`, then compare the files.
- Runs are noisy. `eval run --repeat <n>` (default 1) runs each brief n times; compare shows the median and the min–max range. A regression is only flagged when the ranges do not overlap.

## Tiers

| Tier | Briefs | Settings | Target cost | Use |
|---|---|---|---|---|
| smoke | 2 | `branding.enabled: false`, `marketing.enabled: false`, `qa.maxRounds: 1`, `parallelTasks: 2`, cheaper models allowed via `--config` | under $5 total | every prompt or harness change |
| full | all 6 | production defaults from `pipeline.example.yaml` (gates off, no deploy, no publish) | $60–120 | before a release or a model change |

`--tier full` includes the smoke briefs.

## Cost controls

- Each brief's `budgetUsd` becomes `budget.runUsd` for that project. The existing budget stop (`awaiting_approval`, kind `budget`) ends the brief.
- `eval run --max-usd <n>` caps the whole suite: before each brief, sum `costUsd` of finished briefs; stop and write a partial result (`"aborted": "budget"`) when the next brief's `budgetUsd` would pass the cap.
- `timeoutMinutes` per brief aborts the run through the same `AbortController` that `run()` uses for SIGINT.
- Codex reports no cost. Show `unreportedCalls` next to cost in every table so a cheap-looking codex run is not misread.
- Print the planned maximum spend (sum of `budgetUsd`) before starting and ask for confirmation unless `--yes` is passed.

## Dashboard (optional)

- A read-only "Evals" page in `web/src/pages/evals.tsx` that lists result files and shows a compare table for two picked results.
- API in `src/ui/server.ts`: `GET /api/evals` (list of results with id, sha, label, tier, totals) and `GET /api/evals/<id>`. The server reads `<runsDir>/../evals/results` or a `--evals-dir` flag.
- Link each brief row to its project page when the project dir still exists.
- Skip this until the CLI has been used for a few weeks.

## Tests

In `test/evals.test.ts`, using the stub harness pattern from `test/task-loop.test.ts`:

- `loadBrief` reads `brief.md` and `eval.yaml`, applies defaults, and rejects an unknown tier or a missing `budgetUsd`.
- `suiteConfig` forces gates off, deploy off, publish off, and applies tier settings and brief overrides in that order.
- `store.evalSummary()` on an in-memory store with seeded attempts, reviews, and tasks returns the expected counts, cost, and tokens.
- `runEval` with a stub harness that completes a two-task plan writes a result file that matches the schema; with a stub that exceeds budget, records `awaiting_approval` and kind `budget`.
- `--max-usd` stops before a brief that would pass the cap.
- `compareResults` flags a regression on a worse outcome, on cost +25%, and on fewer merged tasks; does not flag overlapping ranges with `--repeat`.
- No test calls a real runner or Docker.

## Implementation steps

1. `src/project.ts`: extract the body of `run()` in `src/cli.ts` into `runProject(projectDir, signal)` returning `RunOutcome`. `run()` calls it and keeps signal handling and exit codes.
2. `src/store.ts`: add `evalSummary()` (tasks, attempts by role, fallbacks, reviews, `projectCost()`, token sum).
3. `src/evals.ts`: `loadBrief`, `listBriefs(tier, ids)`, `suiteConfig(base, tier, brief)`, `hashBrief`, `hashConfig`.
4. `src/evals.ts`: `runEval({ evalsDir, tier, briefIds, configPath, label, maxUsd, repeat, signal, runProject })`. Creates each project with `createProject`, writes the merged `pipeline.yaml`, calls `runProject`, reads `evalSummary()`, handles cooldown resumes and the timeout, writes the result file. `runProject` is injected so tests pass a stub.
5. `src/evals.ts`: `compareResults(a, b)` and `formatComparison`.
6. `src/cli.ts`: add `eval run` and `eval compare` to `usage` and `main()`, including `--rev` with `git worktree add` under `<evalsDir>/revs/`.
7. `evals/briefs/`: add the 2 smoke briefs, run the smoke tier, and commit a baseline result (see open questions).
8. `test/evals.test.ts`: the tests above.
9. `README.md`: an "Evals" section with the commands, tiers, and expected cost.
10. Optional: `/api/evals` in `src/ui/server.ts` and `web/src/pages/evals.tsx`.
11. Add the 4 full-tier briefs once smoke results are stable across 3 repeats.

## Open questions

- **Pass criteria beyond the pipeline's own QA.** QA is run by an agent in this repo, so a lenient QA prompt would score itself well. Should each brief carry a small hidden acceptance check (for example `evals/briefs/<id>/check.sh` that curls routes on the built app)? This is the strongest signal but needs the app started, which today only `deploy` and `src/smoke.ts` do.
- **Where results live.** Commit results to the repo (easy history, noisy diffs) or keep them outside (`~/.agent-team/evals`)? Proposed: commit only labeled baselines.
- **Token field meaning.** `attempts.tokens` comes from `claudeTokens` and includes cache reads; codex may report none. Should compare show input, output, and cache separately? That needs new columns.
- **Doctor.** Should the doctor watch eval projects? Proposed: no; eval dirs sit outside `runsDir`, so its repairs cannot hide failures.
- **Planner nondeterminism.** Task counts differ run to run, so "tasks merged" alone is weak. Proposed primary metric: outcome, then merged/total ratio, then cost per merged task.
- **Model drift.** A provider can change a model under the same name. Record runner CLI versions (`claude --version`, `codex --version`) in the result so a shift can be traced.
