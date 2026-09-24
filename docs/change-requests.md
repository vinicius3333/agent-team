# Change requests: spec

Today a project ends once deploy passes. To add a feature to a live app, the user has to create a new project and rebuild the app from zero. This spec lets the user send a change request ("add CSV export to the reports page") to a finished project. The pipeline plans only the change, builds it on a branch against the existing code, runs QA, merges once, and redeploys. Read `README.md`, `src/pipeline.ts` (`runStages`, `runPlanningPhase`, `attemptPhase`, `buildTasks`, `runQaPhase`, `appendFixTasks`, `landTasksFile`, `runDeployPhase`), `src/project.ts`, `src/tasks.ts`, `src/replan.ts`, `src/store.ts`, `src/qa.ts` (`runQaLoop`), `src/github.ts`, `src/feedback.ts`, `src/ui/server.ts` (`handlePost`), and `prompts/planner.md` first.

Rules for all items: match the repo style (no semicolons, double quotes, erasable TS, `.ts` imports); add tests with stubs; keep `npx tsc --noEmit`, `npm test`, and `npm run build:ui` passing; log every automatic decision as an event; projects with no change requests behave exactly as today.

## Group A: user flow

### A1. Dashboard

- The project page shows a **Request a change** panel once the run is `completed` (deploy approved, or deploy disabled and QA approved). It holds a text box and a **Submit** button. The panel is hidden while a run is alive (`runAlive`) or while another change is open.
- New route `POST /api/projects/<name>/changes` with `{ "request": "..." }` in `handlePost`. It calls `openChange` (C2), then `startRunIfIdle`. Reply `409` when a run is alive or a change is open, `400` when the text is empty or over 4000 characters.
- The project page lists past changes: id, first line of the request, status, branch, PR link, and dates. Add a `changes` array to the project detail API.
- Gates work as today. The approval panel shows the change's spec delta and task list, labeled with the change id.

### A2. Command line

- `agent-team change <projectDir> --request <file>` opens a change. Run `agent-team run <projectDir>` afterward, like `init`.
- `agent-team status <projectDir>` prints the open change id and its status above the phases.
- Add both to `usage` in `src/cli.ts` and to the README's "Command line" section.

## Group B: which phases rerun

A change reruns `spec`, `architecture`, `plan`, QA, and deploy. It skips `branding`, `design`, and `marketing` unless B4 applies.

### B1. Spec delta

- The pm gets `input.md`, the current `docs/spec.md`, and the change request at `docs/changes/<id>/request.md`.
- It writes `docs/changes/<id>/spec.md` with headings `## Change`, `## New or changed user stories`, `## Out of scope`, `## Open questions`. New stories continue the numbering (`US-07` after `US-06`).
- It also edits `docs/spec.md` in place so the spec describes the app after the change. Validation: the delta headings exist, and every story id in the delta also appears in `docs/spec.md`.
- New section in `prompts/pm.md`, used only when `{{change}}` is set: "You are changing an app that already exists. Do not rewrite stories that the change does not touch."

### B2. Architecture delta

- The architect gets the spec delta, the current `docs/architecture.md`, `AGENTS.md`, and a `git ls-files` tree (reuse the code-map builder with `maxCodeMapLines`).
- It writes `docs/changes/<id>/architecture.md` (`## Changes`, `## New dependencies`, `## Data migrations`, `## Risks`) and edits `docs/architecture.md` and `AGENTS.md` only where they change. `## Commands` must still exist.
- A new ADR goes in `docs/adr/` as today.

### B3. Plan: only new tasks

- The planner gets the deltas, the current `tasks.json`, `docs/progress.md`, and the code map. It returns only the new tasks.
- New ids continue after the highest existing id (`T031` after `T030`, QA fix ids included). Tasks may list merged tasks in `dependsOn`. The change has no scaffold task: rule 1 of `prompts/planner.md` does not apply in change mode.
- Scope rule: a new task may own paths that merged tasks owned. It may not own shared foundation files (`sharedFoundationPatterns` in `src/replan.ts`) unless its `phase` is `"foundation"`. Check with `scopeConflict(paths, openTasks, mergedIds)`.
- The orchestrator appends the new tasks to `tasks.json` and validates the full list with `validateTasks` and `orderTasks`. It rejects the output when the planner returned an existing id or changed an existing task.
- Every new task gets `"change": "<id>"` (new optional field on `Task`). The worker prompt includes `docs/changes/<id>/request.md` as a read path.

### B4. Design and branding

- The architect's delta may set `Design: needed` on its first line when the change adds or changes screens. Then the `design` phase reruns in change mode: the designer edits `docs/design.md` (new `Route:` lines) and may add tokens but must keep existing ones. Branding and marketing never rerun for a change.
- `target: api` projects skip design as today.

## Group C: data model and reuse

### C1. Files in the project repo

| Path | Written by | Purpose |
|------|-----------|---------|
| `docs/changes/<id>/request.md` | orchestrator | The user's text, verbatim |
| `docs/changes/<id>/spec.md` | pm | Spec delta |
| `docs/changes/<id>/architecture.md` | architect | Architecture delta |
| `docs/spec.md`, `docs/architecture.md`, `AGENTS.md`, `docs/design.md` | phase agents | Updated in place, so they always describe the current app |
| `tasks.json` | orchestrator | Existing tasks kept; new tasks appended with `change` |
| `docs/progress.md` | orchestrator | Appended per merged task, as today |

Change ids are `C001`, `C002`, and so on. `docs/changes/` is a planning output: add it to `protectedPrefixes` in `src/replan.ts` so no worker task may own it.

### C2. State in `state.db`

- New table `changes (id TEXT PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL, branch TEXT NOT NULL, base_commit TEXT NOT NULL, pr_url TEXT, created_at TEXT NOT NULL, finished_at TEXT)`. Status is `open`, `merged`, `failed`, or `abandoned`. At most one `open` row.
- Meta key `change.current` holds the open change id, or is empty.
- Phase rows stay one per phase name. `openChange` archives the finished rows by copying them into a new table `phase_history (change_id, name, status, updated_at)` (`change_id` is `""` for the first build), then sets `spec`, `architecture`, `plan`, `qa`, and `deploy` to `pending`. When the architecture delta asks for design (B4), the orchestrator sets `design` to `pending` after the architecture phase lands. It clears `qa.round`. It keeps `deploy.url`, the demo account, GitHub meta, and the epic.
- Task rows: `syncTasks` already adds new ids as `pending`. Merged rows stay merged, so `buildTasks` runs only the new tasks with no change.
- `runStages` does not change: every phase that is `approved` is skipped by `runPlanningPhase`, and the reset phases run again. The phase prompts read `change.current` to pick change mode.
- Add `store.openChange`, `store.currentChange`, `store.finishChange(id, status, prUrl)`, `store.changes()`.

### C3. The marketing skip rule

`runPlanningPhase` skips marketing when `plan` is already approved ("planned before the marketing phase existed"). After `openChange` resets `plan`, that check no longer holds. Change it to: skip marketing when a change is open, or when `plan` is approved and marketing has no row.

## Group D: git and GitHub

### D1. One branch per change

- `openChange` creates `change/<id>-<slug>` from `main` and records `base_commit`.
- All phase and task workspaces for the change branch from `change/<id>`, not `main`, and land on it. This needs a base branch in `createWorkspace`, `commitAndRebase`, and `fastForwardMain` (`src/harness/workspace.ts`), and in `github.land`. Read the base from `store.currentChange()` in one helper, `landingBranch(context)`, so no caller passes it by hand.
- `main` does not move during the change. The live app keeps running from `main` until D3.

### D2. Pull requests

- With GitHub on: each phase and task PR targets `change/<id>` (`gh pr create --base`). Push the change branch on open.
- A new issue "Change C001: <first line>" with label `change` acts as the change's epic. Task issues link it instead of the build epic. Add `change` to `labels` in `src/github.ts`.
- With GitHub off: `localMerge` fast-forwards `change/<id>` instead of `main`.

### D3. Final merge

- After QA passes, the orchestrator opens one PR `change/<id>` into `main` titled `feat: <first line of request>`, with the spec delta, task list, and QA summary. It merges it with `--merge` (no squash, no rebase) and fast-forwards local `main`, then deploys.
- If `main` moved during the change (a doctor hotfix or manual commit), rebase is not allowed: merge `main` into `change/<id>` first. On a conflict, stop with `awaiting_approval` and the conflicting files in the stop reason.
- Add `autonomy.changeMerge: "auto" | "manual"` (default `"auto"`). With `manual`, the run stops at `awaiting_approval` with the PR link, and **Approve** on the dashboard merges and deploys.

## Group E: QA and deploy

### E1. QA scope

- QA runs the full test suite as today. The whole app must still pass.
- Screenshots cover every `Route:` line, as today. The QA prompt gets the change's routes (from its tasks' `routes`) and the spec delta, and is told: "Judge the change's routes against the delta. On other routes, fail only on regressions." Round artifacts go to `.agent-team/qa/<changeId>/round-<n>/` so the first build's rounds stay.
- Fix tasks get `change: <id>` and land on the change branch through `appendFixTasks`.

### E2. Redeploy

- `runDeployPhase` returns early when deploy is approved and `deploy.url` is set. Since `openChange` resets deploy to `pending`, the check passes only after the new deploy.
- Deploy runs from `main` after D3, through `deployProject`, which replaces the running container. The tunnel URL may change; the project page and the change issue show the new URL.
- If deploy fails after the merge, `main` holds the change but the old container is gone. Keep the old container running until the new one passes `waitForApp`, then swap. This needs a second container name in `deployProject`. See open question 3.

## Group F: edge cases

1. Change requested while a run is alive: `409`.
2. Change requested on a project whose first build did not finish: `409` with "Finish or fix the current run first."
3. Change fails (a phase `failed`, QA gives up): status stays `open`. The user can retry the task or resume, as today. **Abandon** on the dashboard (`POST .../changes/<id>/abandon`) sets status `abandoned`, restores the archived phase rows, deletes the change's task rows, restores `tasks.json` on `main` (untouched, since the change lived on its branch), and closes the change issue and PRs.
4. Request changes at a gate: works as today; feedback files are per phase and get archived on approve.
5. The planner returns zero tasks (the change is already done or only needs docs): land the docs on the branch, skip build and QA, merge, and log it. No redeploy.
6. The change needs a new dependency: the task must be `phase: "foundation"` to own `package.json` and the lockfile (B3).
7. Data migrations on a live app with real data: out of scope. The README already says not to deploy apps with real data.
8. Budget: `budget.runUsd` applies per run, as today. Store the change id on each `attempts` row (new nullable column `change_id`) so the dashboard can show cost per change.
9. Doctor: incidents on a change run use the change branch. `src/doctor.ts` resume logic must not reset phases that `openChange` set.
10. Old projects with no `changes` table: created by `openStore`; `change.current` missing means no change.

## Group G: tests

In `test/change.test.ts`, with the stub harness from `test/task-loop.test.ts`:

1. `openChange` on a completed project resets the five phases, keeps merged task rows, archives phase rows, and creates the branch.
2. `openChange` refuses when a run is alive, a change is open, or the build is not complete.
3. A planner output with an existing id, an edited existing task, or a foundation file owned by a feature task is rejected.
4. Only new tasks run; merged tasks do not rerun.
5. Task and phase workspaces branch from and land on `change/<id>`; `main` does not move until the final merge.
6. The final merge runs after QA passes, then deploy runs once.
7. A conflict with `main` stops the run at `awaiting_approval` with the files in the stop reason.
8. Abandon restores phase rows and removes the change's task rows.
9. The marketing phase is skipped during a change.
10. Dashboard: `POST /changes` returns 409 and 400 in the right cases (`test/dashboard.test.ts`).

## Implementation steps

1. `src/store.ts`: `changes` and `phase_history` tables, `change_id` on `attempts`, and the store functions from C2.
2. `src/tasks.ts`: optional `change` field on `Task`, checked in `validateTasks`. Add `nextTaskId(tasks)`.
3. `src/project.ts`: `openChange(projectDir, store, request)` and `abandonChange(projectDir, store, id)`, both throwing `ProjectError`.
4. `src/harness/workspace.ts`: base branch parameter on `createWorkspace`, `commitAndRebase`, `fastForwardMain`; `landingBranch(context)` in `src/pipeline.ts`; switch every caller.
5. `src/github.ts`: `--base` on `mergeThroughPullRequest`, change issue, `change` label, `mergeChange(changeId)` for D3.
6. `src/pipeline.ts`: change mode in `phasePrompt` and phase `validate` for spec, architecture, and plan; append-only plan landing through `landTasksFile`; the marketing rule in `runPlanningPhase`; the zero-task path; D3 merge step between `runQaPhase` and `runDeployPhase` inside `runTasks`; `finishChange` on completion.
7. `prompts/pm.md`, `prompts/architect.md`, `prompts/planner.md`, `prompts/qa.md`, `prompts/designer.md`: change-mode sections.
8. `src/replan.ts`: add `docs/changes/` to `protectedPrefixes`.
9. `src/qa.ts` and `runQaRound`: per-change round directory and change-aware prompt input.
10. `src/deploy.ts`: start the new container before removing the old one.
11. `src/cli.ts`: `change` command and `status` output.
12. `src/ui/server.ts`: `POST .../changes`, `POST .../changes/<id>/abandon`, `changes` in the detail API. `web/src/pages/project.tsx`: the panel and the list.
13. `src/doctor.ts`: respect the open change when resuming.
14. Tests from Group G, then README sections "Change requests" and "Command line".

## Open questions

1. Integration branch (D1) or per-task PRs straight to `main`, as today? The branch keeps the live app stable and gives one reviewable PR, but touches every landing call. Per-task PRs to `main` are far less work but leave `main` half-changed while the change builds.
2. Should the user be able to queue several changes, or is one open change at a time enough?
3. Is zero-downtime redeploy (E2) worth the work, given the app is a preview with a quick-tunnel URL that already changes on each deploy?
4. Should `spec` and `plan` gates default to on for changes, even when the first build ran without gates? A change to a live app may deserve review by default.
5. Should the pm be allowed to refuse a change that contradicts the spec (and say why), or always write a delta?
6. `docs/spec.md` edited in place (B1) makes the delta and the full spec two sources of truth. Is keeping only deltas, and giving agents all deltas in order, better?

## Decisions

The implementation resolved the open questions and a few gaps with the safest simple choice.

| Question | Decision |
|---|---|
| 1. Integration branch or per-task PRs to `main` | Integration branch (D1). `main` and the live app stay stable, and the change lands as one reviewable merge. |
| 2. Queue several changes | No. One open change at a time; the API answers `409` while one is open. |
| 3. Zero-downtime redeploy (E2) | Not done. The preview URL already changes on every deploy, so `deployProject` keeps replacing the container. A failed deploy after the merge stops the run as today, and `agent-team run` retries it from `main`. |
| 4. Gates on by default for changes | No. Changes use `autonomy.gates` like the first build. `autonomy.changeMerge: manual` is the review switch for the final merge. |
| 5. May the pm refuse a change | No. The pm always writes a delta and lists contradictions under `## Open questions`, where a gate on `spec` shows them. |
| 6. Deltas only, or edit `docs/spec.md` in place | Both, as specified: the full documents always describe the current app, and the deltas record each change. |

Other choices:

- **Change mode in prompts.** The phase task prompt starts with `Change mode: change request <id>`, and each prompt file has a `## Change mode` section. This replaces the `{{change}}` variable, because unset variables stay in the prompt as literal text.
- **Planner output.** The planner writes the new tasks to `docs/changes/<id>/tasks.json` (`[]` for no code). The orchestrator appends them to `tasks.json` in the same phase commit. The plan is rejected when `tasks.json` itself was edited, a new id already exists or does not continue after the highest `T` id, or a feature task owns a shared foundation file.
- **QA round numbers.** `openChange` keeps `qa.round`. QA fix ids are `Q<round><nn>`, so restarting the count would reuse ids like `Q101` from the first build. Round folders still go to `.agent-team/qa/<id>/round-<n>/`, and the dashboard shows the newest change's rounds.
- **`docs/changes/` in `protectedPrefixes`.** Not added: `docs/` is already protected, so the extra prefix would change nothing.
- **Human edits at a gate during a change.** Approve and Request changes do not commit edits from the project folder while a change is open, because that folder is `main` and `main` must not move. Use the feedback box instead.
- **Manual merge.** With `changeMerge: manual`, the run stops before it opens the final pull request. **Approve merge** on the dashboard (`POST .../changes/<id>/merge`) records the approval and starts the run, which opens and merges the pull request.
- **Abandon.** It removes the task rows marked with the change id on the change branch (plan and QA fix tasks), restores the phase rows archived when the change opened, and keeps the branch.
- **Change finished.** The change is marked `merged` and `change.current` is cleared at the final merge, so the redeploy and any deploy fix run from `main`.
- **Notifications.** A new `change` kind: opened and merged are info; waiting for a merge approval or a conflict fix needs you.
