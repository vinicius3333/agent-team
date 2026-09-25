---
name: new-feature
description: How we build a new feature in agent-team, from questions to pushed commits - explore what exists, ask the open decisions, build the backend in layers, draw UI prototypes with Codex image generation, implement and screenshot the UI, document, verify, and commit. Use when adding or reshaping a feature of the orchestrator or the dashboard (for example "add sprints", "add a view for X", "replace the evolve loop").
---

# New feature in agent-team

Follow the steps in order. Each step names where the code goes and how to check it.

## 1. Find what already exists

agent-team already has many loops. A new feature usually joins pieces that exist instead of adding a new one.

| Piece | Where | What it gives you |
| --- | --- | --- |
| Pipeline and phases | `src/pipeline.ts`, `src/run.ts` | A run: plan, build, QA, deploy |
| Change requests | `openChange` in `src/project.ts`, `docs/change-requests.md` | Ship any request on a branch, with QA, merge, and redeploy |
| Doctor tick | `runDoctor` in `src/doctor.ts` | A job that runs every 60 seconds for every project |
| Operate | `src/operate/` | Scheduled agents that write findings (the backlog) |
| Sprints | `src/sprint.ts`, `startSprint` in `src/improve.ts` | Scheduled evaluate, plan, and ship cycles |
| Learning | `learnLessons` in `src/improve.ts`, `src/lessons.ts` | Lessons in every agent's system prompt |
| Notifications | `src/notify/events.ts` | Alerts matched on exact log phrases |

Read the README section and the `docs/<area>.md` of the pieces you touch before you design. Say which pieces overlap with the request, and propose a reuse.

## 2. Ask the open decisions

Use `AskUserQuestion` for decisions that change the design. Give 2 to 4 options each, with the recommended one first. Typical questions:

- How the feature relates to an existing one: replace it, live beside it, or extend it.
- When it runs: a fixed interval, continuous, or on demand.
- What it may do without a person, and what stops it (budget caps, gates).
- Which inputs it reads.

Do not guess a decision the user should make. Once it is answered, do not reopen it.

## 3. Build the backend in layers

Work bottom up, and run `npx tsc --noEmit` after each layer.

1. **Store** (`src/store.ts`): add tables with `CREATE TABLE IF NOT EXISTS` and new columns with a `PRAGMA table_info` check plus `ALTER TABLE`, so old `state.db` files keep working. Export `as const` lists and their types for enums.
2. **Config** (`src/config.ts`): an interface with a comment per non-obvious field, a `default...Config`, a `normalize...` function that also reads the old key when you rename one, and a `...Problems` function called from `validateConfig`. Update `pipeline.example.yaml` with a comment on every key.
3. **Logic module** (`src/<feature>.ts`): pure functions first. Parse agent replies with `extractJsonObject` and throw one error that lists every problem, so a retry can fix them all. Keep scheduling rules in one function that returns the reason it cannot run, or `null`.
4. **Agent calls**: use `runAgent(context, executor, role, subject, tools, prompt, { promptName })` inside a worktree (`createWorkspace`, `createExecutor`), with 2 attempts that pass the previous error back. Reuse an existing role with a new prompt in `prompts/<name>.md` before you add a role.
5. **Entry points**: a run step goes through `runProject(..., prepare)` in `src/run.ts`; a background job goes in the doctor tick; a command goes in `src/cli.ts` (usage text, `parseArgs` options, `switch`); dashboard routes go in `src/ui/server.ts` (`handlePost` for POST, the GET block for reads). Throw `ProjectError(status, message)` for user errors.
6. **Logs**: `store.log("<kind>", message)` for every decision a person may ask about later, including why something did not start.

Keep caps explicit (money, items, retries), and make every automatic action visible in the log and the dashboard.

## 4. Write the tests

Add `test/<feature>.test.ts` with `node:test`:

- a fresh store per test: `openStore(join(scratch, "state-<n>.db"))`
- pure parsers: valid input, and each rejection with its message
- scheduling rules with an explicit `now`
- the doctor tick with a stubbed `startRun`
- dashboard routes with `startUi({ runsDir, port: 0, auth: { mode: "none" }, notifications: false, startRun: stub })` and `fetch`, sending the `x-agent-team: 1` header on POST

Existing tests mark a live run with `store.setMeta("run.pid", String(process.pid))`. When code must ignore its own run, pass an explicit flag (such as `insideRun`) instead of comparing pids.

## 5. Draw UI prototypes with Codex image generation

Draw every new screen before you write any UI code.

1. Create `docs/mockups/<feature>/`.
2. Write one `<screen>.prompt.txt` per screen. Start from the style block in `docs/mockups/project-hierarchy/next-steps.prompt.txt`: palette, Inter, Lucide icons, the sidebar tree, and "flat crisp production dashboard screenshot". Then describe the screen: the selected sidebar item, the breadcrumb, the heading, and every card with its real strings and numbers. Draw desktop at 1440x900, plus 390x844 for mobile.
3. Attach an existing screen as the style reference, and pass the prompt on stdin. `-i` takes several files, so a prompt passed as an argument after it is read as an image path:

   ```sh
   cd docs/mockups/<feature>
   REF=../project-hierarchy/v2/next-steps.png
   for name in <screen-a> <screen-b>; do
     ( { cat $name.prompt.txt
         printf '\nWhen the image is generated, save it as %s.png in the current directory. Do not create or change any other file.\n' $name
       } | codex exec --skip-git-repo-check -s workspace-write -C "$PWD" -i "$REF" - > $name.log 2>&1 ) &
   done; wait
   ```

   Run it in the background; each image takes a few minutes.
4. Open each PNG and check the text, the layout, and the sidebar. Redraw a screen with a sharper prompt when it is wrong. Delete the `.log` files; keep the `.png` and `.prompt.txt` files.
5. Show the user the prototypes before you build them when the design is open.

## 6. Implement the UI

The dashboard is React, Tailwind, and shadcn/ui in `web/src`.

| Change | Where |
| --- | --- |
| Response and request types | `web/src/api/types.ts` |
| API calls | `web/src/api/client.ts` |
| Polling data hook | `usePolled` in `web/src/components/operate/use-operate.ts` |
| A new view | `web/src/components/<area>/<view>.tsx`, the entry in `phaseViews` in `web/src/lib/navigation.ts`, and the `case` in `web/src/pages/project.tsx` |
| Status colors | `statusTones` in `web/src/components/status-badge.tsx` |

Rules: reuse `Card`, `StatusBadge`, `SeverityBadge`, `EmptyState`, and `Sheet` (the bottom sheet on mobile). Give tap targets at least 44px on phones (`h-11 sm:h-9`). No horizontal scroll at 390px. Show why a button is disabled.

Check: `cd web && npx tsc -b && npm run build`.

## 7. Screenshot the real UI and compare

1. Make a demo project in the scratchpad: `node src/cli.ts init <scratch>/runs/demo --brief <file>`, then `node scripts/seed-operate.ts <scratch>/runs/demo`, plus a small script that seeds the feature's rows through `openProjectStore`.
2. Start the dashboard in the background: `node src/cli.ts ui <scratch>/runs --port 4477`.
3. Install Playwright in the scratchpad (`npm i playwright@latest`, which matches the cached browsers) and screenshot each view at 1440x900 and 390x844. Log `document.documentElement.scrollWidth > window.innerWidth` to catch horizontal scroll.
4. Compare each screenshot with its prototype, fix the gaps, and shoot again. Stop the dashboard when done.

## 8. Document

Write in plain language: short sentences, active voice, and tables for settings and states.

- `docs/<feature>.md`: what it does, the settings, when it runs, each step, the commands and views, and how older projects migrate.
- The README: a short section that links to the doc, plus the CLI examples.
- Prompt files: say who the agent is, what it reads, how to decide, and the exact JSON to return.

## 9. Verify

Run all of them and report the numbers:

```sh
npx tsc --noEmit
npm test
cd web && npx tsc -b && npm run build
```

## 10. Commit and push

Only when the user asks. Use conventional commits (`<type>(<scope>): <subject>`, imperative, 50 characters at most), one logical change per commit, and never add AI attribution. A usual split:

1. `feat(<feature>): ...` for the store, config, logic, CLI, doctor, and routes, with their tests
2. `feat(ui): ...` for the dashboard views
3. `docs(mockups): ...` for the prototypes
4. `docs(<feature>): ...` for the docs and README
5. `refactor: remove ...` when the feature replaces an older one (in the same commit as the feature when the build would break without it)

Never bypass git hooks. Stage paths explicitly; never `git add -A`.
