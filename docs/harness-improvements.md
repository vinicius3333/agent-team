# Harness improvements: spec

These changes come from a review of published practice (Anthropic engineering posts on effective agents, context engineering, long-running harnesses, and multi-agent research; Cognition's "Don't build multi-agents"; AGENTS.md; SWE-agent; 2025–2026 papers on LLM code review). Read `src/pipeline.ts`, `src/qa.ts`, `src/harness/*.ts`, `src/tasks.ts`, `src/store.ts`, and `prompts/*.md` first.

Rules for all items: match the repo style (no semicolons, double quotes, erasable TS, `.ts` imports); add tests with stubs; keep `npx tsc --noEmit`, `npm test`, and `npm run build:ui` passing; log every automatic decision as an event.

## Group A: the task loop

### A1. Replan a blocked task

Today a `BLOCKED:` result ends the run until a human retries.

- Workers report blocks in a structured form: `BLOCKED: {"kind":"scope"|"dependency"|"spec","needPaths":[...],"reason":"..."}`. Keep accepting the old free-text form (treat it as `kind: "spec"`). Update `prompts/worker.md` with one example.
- On a block, call `replanTask(context, task, block)`: the planner role gets the task, the block, the other tasks with status, and `git ls-files`. It returns one JSON object: `{"action":"rebind","allowedPaths":[...]}` (widen scope), `{"action":"prereq","task":{...}}` (insert a new task that the blocked task then depends on), `{"action":"split","tasks":[...]}` (replace the task), or `{"action":"escalate","reason":"..."}`. New prompt `prompts/replanner.md`.
- Validate with `validateTasks` on the full updated list. Write the change to `tasks.json` on main through the same landing path QA fix tasks use.
- Guardrails: at most one replan per task. A rebind that adds a path owned by another task, or a shared foundation file (package manifest, lockfile, app entry, router: take the list from the planner's foundation-task convention), needs a human: set the task to `blocked` with a clear message and end with `awaiting_approval` so the dashboard can show it. `escalate` does the same.
- Reset the task's attempts after a successful replan.

### A2. Retries carry the previous attempt

Save the rejected diff (`stagedDiff`, capped at 40 KB) and the failure reason to `.agent-team/attempts/<task>-<n>.diff` and pass both to the next attempt's prompt, with the instruction to fix the listed problems rather than start over.

### A3. Enforce scope while the agent edits

For Claude runners, pass path-scoped permission rules built from `allowedPaths` (for example `Edit(src/auth/**)`, `Write(src/auth/**)`) so edits outside the scope are denied immediately. Check the Claude runner in `src/runners/claude.ts` and how tools are passed today. For Codex, keep today's behavior. The post-run `filesOutsideScope` check stays as a backstop.

### A4. Strict verdict parsing

Replace the greedy regex in `parseVerdict` (and the QA verdict parser) with: take the last fenced ```json block if present, else the last balanced top-level JSON object found by a small scanner; validate the shape; on failure, return a clear error so the reviewer is asked again once. Update the reviewer and QA prompts to require one ```json block.

### A5. Flaky tests and repeated failures

- When `verify` fails, run it once more. If it passes, continue and log a `flaky` event. Same for the QA test gate.
- If an attempt fails with the same normalized failure text as the previous attempt (strip timestamps, durations, paths under /tmp), block the task early and send it to A1 instead of spending the remaining attempts.

## Group B: context and cost

### B1. Progress log

After each merged task, the orchestrator (not the agent) appends to `docs/progress.md` on main: task id, title, files changed, and the worker's final summary cut to three lines. Every worker and reviewer gets `docs/progress.md` as a read path.

### B2. AGENTS.md in the generated repo

The architect also writes `AGENTS.md` at the repo root: commands (same as `## Commands`), directory layout, conventions, and "read docs/progress.md first". Under 80 lines. The harness creates `CLAUDE.md` containing only `@AGENTS.md` if it does not exist. Validation checks AGENTS.md has a `## Commands` heading. Workers may not edit either file.

### B3. Code map for workers

Add to the worker prompt a compact `git ls-files` tree (capped at 200 lines, skipping lockfiles and assets) and the list of files changed by the task's `dependsOn` tasks.

### B4. Reviewer context and honesty

- `reviewPrompt` puts the task and acceptance criteria after the diff too (restate the goal at the end).
- Give the reviewer `docs/progress.md` and the files from `dependsOn` tasks.
- Replace "A different model wrote the code" with the real writer runner and model, filled in by the harness.

### B5. Per-task UI smoke check

For tasks whose `allowedPaths` touch UI code (the planner marks them with `"ui": true` in tasks.json; extend the schema as optional), after `verify` passes, start the app from the task's worktree and load the task's routes (new optional field `routes`) with the QA screenshot machinery in `src/screenshots.ts`. Fail the attempt on HTTP ≥ 400, load errors, or console errors, with the details as the failure reason. No vision review here. Skip when `deploy.json` is missing or the app does not start within the timeout (log it, do not fail).

### B6. Run budget

`budget.runUsd` (default 30). Before each agent call, sum reported cost for the run. If over budget, stop with outcome `awaiting_approval` and a `budget` event. The dashboard shows it and offers "Raise budget and resume" (POST that updates pipeline.yaml's `budget.runUsd` by +50% and starts the run). Codex reports no cost; count its calls in the event message.

### B7. Reviewer metrics

Store verdict per review attempt (already in attempts? check) and show on the dashboard: reviews, fail rate, and fails later confirmed (the next attempt changed the flagged files). Plain numbers on the Agent calls tab.

### B8. Show why a run paused

The dashboard shows the last pause or failure reason on the project page (for example the workspace setup error with the key `npm error` lines), not just "paused". Add the field to the detail API.
