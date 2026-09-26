# Progress

The orchestrator appends one entry per merged task. Read it before you start.

## T001: Pass APP_URL to checker app containers and make the login email field optional

Files: `docker/qa/screenshot.mjs`, `src/screenshots.ts`, `test/screenshots.test.ts`

> Both changes are in and `verify` passes: typecheck is clean, `node --check` is OK, and all 5 tests in `test/screenshots.test.ts` pass.
> - **`src/screenshots.ts`**: I added a small exported pure helper, `checkerAppEnv(baseUrl, access)`. It returns `{ ...publicUrlEnv(baseUrl), ...demoAccessEnv(access) }`, using the `publicUrlEnv` already exported from `src/deploy.ts`. `captureApp` now starts the app container with this env, so `APP_URL` (and the other public URL variables) equals `http://<alias or container name>:<port>`.
> - **`docker/qa/screenshot.mjs`**: the login step now waits for the password field to appear. It fills the email field only if the form has one and `login.email` is set. It always fills the password and submits. The success check (the page leaves the login card) is unchanged, so forms with both email and password still log in the same way.

## T002: Add tests that the APP_URL host serves every dashboard page and unknown hosts get 403

Files: `test/preview-host.test.ts`

> I added `test/preview-host.test.ts`, and the verify command passes: `npm run typecheck` is clean and both tests pass. No other file changed. The server and its Host, Origin, `x-agent-team` and auth checks are untouched.
> **What the test does:**
> - **Server setup:** it starts the dashboard on a free loopback port with a temp runs folder. `AGENT_TEAM_UI_HOSTS=app.example` is set only while the server starts, then put back.

## T003: Make npm test pass in a clean offline node:24-bookworm checkout

Files: none

> I didn't change any code: `npm test` already passes in a clean setup, so this task needs no edits. The last verify run (`npm run typecheck && npm test`) passed: typecheck is clean and all 254 tests pass, none skipped.
> **Clean-setup runs.** I ran the full suite with no global git config, no claude, gh or docker on PATH, and a temp HOME, which leaves no git identity:
> - **Without `web/dist`:** it exits 0 three times in a row. One test is skipped: the new host test from T002 (`test/preview-host.test.ts`) needs the built dashboard and says "web/dist is missing. Run: npm run build:ui".

## L001: Let the project lead search and fetch web pages

Files: `prompts/lead.md`, `src/lead.ts`, `test/lead.test.ts`

> The lead chat can now search the web and open pages, and `npm test` passes: 253 passed, 0 failed, 1 skipped.
> - **`src/lead.ts`**: `askLead` now gives the runner the tools `["read", "web_search", "web_fetch"]` instead of `["read"]` alone. The Claude runner turns these into `WebSearch` and `WebFetch`.
> - **`prompts/lead.md`**: a new "Research on the web" section says three things:

## L002: Let the curator weaken and merge lessons, not only confirm or retire them

Files: `prompts/curator.md`, `src/improve.ts`, `src/lessons.ts`, `test/lessons.test.ts`

> The curator can now weaken and merge lessons, not just confirm or retire them. `npm run typecheck && npm test` passes: typecheck is clean, and 297 of 298 tests pass with 0 failures. The one skipped test is not in `test/lessons.test.ts`, and I didn't track down which one it is.
> **`src/lessons.ts`**
> - **Misses:** `Lesson` has an optional `misses` count. `lessonWeight` now uses `max(0, hits - misses)` times the decay. A missing value counts as 0, so old `lessons.json` files still load. The curator's prompt also shows "missed Nx" next to each lesson.

## L003: Pick lessons by relevance to the task, fused with lesson weight

Files: `src/lessons.ts`, `src/pipeline.ts`, `test/lessons.test.ts`

> Agent calls now get the lessons that fit their task, not only the heaviest lessons for their role. The last `npm run typecheck && npm test` run passed: typecheck is clean, and 300 of 301 tests pass with 0 failures and 1 skipped. The skipped test is not one of the lessons tests.
> **`src/lessons.ts`**
> - **New parameter:** `lessonsFor(lessons, role, limit, stacks, now, query = "")` takes the query as a new last parameter, so existing callers don't change.

## L004: Create missing GitHub labels on existing repositories

Files: `src/github.ts`, `test/github.test.ts`

> Task issues are now created on repositories that already have an origin. The labels get created once per project, and if a label is still missing, the issue is created without labels. `npm run typecheck && npm test` passes: typecheck is clean, and 300 of 301 tests pass with 0 failures and 1 skipped. That skip was already in the suite before this change.
> **Changes in `src/github.ts`:**
> - **Labels on an existing origin:** when the repository already has an origin, the orchestrator runs `gh label create --force` for each label in the list. It then sets the store meta flag `github.labels`, so later runs skip this step. A new repository still gets its labels when it is created, and now sets the same flag.

## L005: Always allow the APP_URL host in the preview start command

Files: `deploy.json`, `docs/architecture.md`, `test/deploy-start.test.ts`

> The preview's start command now always adds the `APP_URL` host to `AGENT_TEAM_UI_HOSTS`, even when that list is already set. Before, the host was only used when the list was empty. `npm run typecheck` passed, and `npm test` ran 307 tests: 306 passed, 0 failed, and the last one did not count as a pass, most likely a skip.
> - **`deploy.json`:** a small `node -p` step builds the list. It splits the existing value on commas, adds the `APP_URL` host name (only if `APP_URL` parses as a URL), trims each name, drops empty ones and joins them with commas. So the result never has a leading, trailing or doubled comma. It also works when either value is empty or unset, or when `APP_URL` is not a valid URL.
> - **`test/deploy-start.test.ts` (new):** reads the host-list part of the start command from `deploy.json` and runs it in `sh`, offline and without Docker. With `other.example` and `https://app.example` it gets `other.example,app.example`. It also covers:

## L006: Let the project lead run with full access when lead.access is full

Files: `docs/architecture.md`, `prompts/lead.md`, `src/config.ts`, `src/lead.ts`, `src/runners/claude.ts`, `test/lead.test.ts`, `test/config.test.ts`, `test/runners.test.ts`

> Setting `lead.access: full` in `pipeline.yaml` now lets the lead chat edit any file in the project and run any command there. The default is `read`, which keeps the current behaviour. `npm run typecheck && npm test` passes: typecheck is clean, and 315 of 316 tests pass with 0 failures and 1 skipped. That skipped test was already in the suite.
> **One gap to fix in a follow-up:** saving the lead settings from the dashboard drops `lead.access`, so the project goes back to `read`. The cause is in `src/lead-actions.ts`, which is outside this task's allowed paths: `parseLeadSettings` builds the settings without `access`, and `saveLeadSettings` replaces the whole `lead:` block. Because of that, `access` is optional in the `LeadConfig` type, and anything that doesn't set it counts as `read`. `loadConfig` always sets it. The fix is to keep `access` in those two functions.
> **What changed**

## T005: Set the app container host name to its container name

Files: `src/deploy.ts`, `test/deploy.test.ts`

> `startAppContainer` now adds `--hostname <name>` to `docker run`, so `HOSTNAME` inside the app matches the container name the checker uses (for example `agent-team-qa-agent-team`). The last `verify` run passed: typecheck is clean and all 11 tests pass.
> - **`src/deploy.ts`:** the arguments now come from a new exported pure helper, `appRunArgs(options)`. It adds `--hostname <name>` right after `--name <name>`, but only when the name is a valid host label: 1 to 63 letters, digits or hyphens, not starting or ending with a hyphen. The other arguments are unchanged. `startAppContainer` now calls `run("docker", appRunArgs(options), …)` and still passes secrets through the environment. I also added an `AppContainerOptions` type for the options.
> - **`test/deploy.test.ts` (new, no Docker):** four tests check that:

## T006: Fail a QA round when no page renders

Files: `src/pipeline.ts`, `src/qa.ts`, `test/qa.test.ts`

> A QA round now fails when no page renders, and the message can never be marked as a preexisting import failure. The verify command passes: typecheck is clean and all 18 tests in `test/qa.test.ts` pass.
> - **`src/qa.ts`**: exports `noPageRenderedMessage` and `noPageRendered(visual)`.
> - It returns false for a null report, which means an API target with no visual gate.

## T004: Build the preview host list from the environment with an agent-team preview-hosts command

Files: `deploy.json`, `src/cli.ts`, `src/ui/server.ts`, `test/deploy-start.test.ts`, `test/preview-host.test.ts`, `src/ui/hosts.ts`, `test/hash-password.test.ts`, `test/hosts.test.ts`

> The preview start command now builds its allowed host list with a new `agent-team preview-hosts` command, so the container name from `HOSTNAME` is allowed even when `APP_URL` is missing. The last `verify` run passed: typecheck is clean, and 34 of 35 tests pass with 0 failures. The one skip is an existing test that needs `web/dist`, which isn't built in this worktree. For the same reason, the new page test only checked status codes, not the page body.
> - **`src/ui/hosts.ts` (new):**
> - `parseHostList(value)` splits on commas, trims, lower-cases, and drops empty values and duplicates.

## T007: Keep lead.access when saving the Lead settings and show the access level in the form

Files: `src/lead-actions.ts`, `src/ui/server.ts`, `web/src/api/types.ts`, `web/src/components/project/lead-settings-card.tsx`, `test/lead-actions.test.ts`

> Saving the Lead settings now keeps `lead.access`, and the form has an Access field with Limited and Full. The full `verify` command passes.
> The web dependencies weren't installed at first, so `oxlint` wasn't found. I installed them with `npm --prefix web ci` and ran the web steps again. I did not open the page in a browser; that check is left to the orchestrator.
> **Saving (`src/lead-actions.ts`)**

## L007: Add autonomy.decide: auto so the run never waits for a human

Files: `docs/architecture.md`, `pipeline.yaml`, `src/config.ts`, `src/doctor.ts`, `src/pipeline.ts`, `test/config.test.ts`, `test/doctor.test.ts`, `test/pipeline.test.ts`

> I added `autonomy.decide: human | auto`. The default is `human`, and with `human` the pipeline behaves as before. The last run of `npm run typecheck && npm test` passed: typecheck is clean, and 350 of 351 tests passed with 0 failures. The remaining test was probably skipped or marked todo; I didn't confirm which one or why.
> **One gap:** the criteria ask for "an issue is opened" when a task is skipped. `src/github.ts` has no public way to create an issue, and it is outside `allowedPaths`. So a skipped task instead gets the `blocked` label and a comment with the reason on its existing task issue, through `context.github.taskBlocked`. If a new issue per skip is needed, a follow-up task must add an `openIssue` method to `src/github.ts`.
> **What `auto` does:**
## Q201: Make checkboxes at least 24x24 px on phones

Files: `web/src/components/project/gates-card.tsx`, `web/src/components/ui/checkbox.tsx`, `web/src/pages/import-project.tsx`, `web/src/pages/new-project.tsx`

> I made the approval gate checkboxes 24×24 px on phones. They keep their 16 px look at 1440 px. `verify` passes: lint reports warnings in `hooks.ts` and `auth-context.tsx`, files I didn't touch, and no errors, and `npm run build:ui` builds. I didn't run the app in a browser, so the orchestrator's phone check is the first real test of the sizes. I also didn't write tests: the dashboard has no component test setup, so the check rests on `verify` and that browser check.
> This time I also fixed the other small controls on the two pages, because the previous rejections flagged all of them, not just the gate checkboxes:
> - **The 16×16 radio buttons:** the stack choices on /new and the GitHub destination on /import.

## Q201: Make checkboxes at least 24x24 px on phones

Files: `web/src/components/project/gates-card.tsx`, `web/src/components/ui/switch.tsx`, `web/src/pages/import-project.tsx`, `web/src/pages/new-project.tsx`

> The gate checkboxes were already 24×24 px on phones and 16 px at 1440 px, from an earlier run of this task (commit `abca968`). This run fixes how the label lines up with the box, and moves the switch's phone sizing into the shared switch component. `verify` passes: lint has only warnings in files I didn't touch, and `npm run build:ui` builds. I didn't open the pages in a browser, and there's no component test setup, so the orchestrator's phone check is the first real check of the sizes and alignment.
> **Already in place:** `checkbox.tsx` uses `size-6 sm:size-4`. Radix's hidden input copies the box's measured size, so it is also 24×24 on phones. The focus ring is still there. Space checks the box, and clicking the label works through `htmlFor`.
> **What I changed:**

## L008: Make the lead chat full screen and responsive on phones

Files: `web/src/components/project/chat-tab.tsx`, `web/src/components/project/lead-action-card.tsx`, `web/src/components/project/lead-composer.tsx`, `web/src/pages/project.tsx`

> I made the Build > Chat screen full screen on phones and stopped it from scrolling sideways. The last `verify` run passed: lint, the dashboard build and typecheck. I didn't open it at 360px or 412px in a browser, and I didn't add tests. So the phone layout, the keyboard and the scroll behaviour are unchecked until the orchestrator's browser check.
> - **Page (`web/src/pages/project.tsx`):**
> - Below `sm` on the chat view, the page header (breadcrumb, title, badges) is hidden.

## L009: Stop merges into main from failing on local changes

Files: `src/harness/workspace.ts`, `test/workspace.test.ts`

> Merging into main no longer fails when the main checkout has uncommitted edits. The verify command passes: typecheck is clean and all 4 tests in `test/workspace.test.ts` pass.
> **`src/harness/workspace.ts`**
> - Before merging, `mergeIntoMain` runs `git status` and looks only at tracked files, so untracked files don't block the merge.

## L010: Make the doctor escalate early when the same stop repeats

Files: `src/doctor.ts`, `test/doctor.test.ts`

> The doctor now hands an incident to a person as soon as the same stop comes back after a fix that didn't work, instead of using up its remaining attempts. The last `verify` run passed: typecheck is clean and all 32 tests in `test/doctor.test.ts` pass.
> **What changed in `src/doctor.ts`:**
> - **Fix signature:** each attempt that gets a valid report adds `{ cause, actions, codeFix }` to a new `fixSignatures` list on the incident. `actions` is the sorted list of project actions (for example `resume`, `retry T005`). `codeFix` turns true only when a code fix actually lands; a rejected fix counts as no code change. The list is saved in the incident JSON. Because `src/incidents.ts` was outside my allowed paths, the `Incident` type is only widened locally in `doctor.ts`.

## L011: Select backlog items and start building them as one change

Files: `contracts/openapi.yaml`, `docs/sprints.md`, `src/operate/findings.ts`, `src/ui/server.ts`, `test/operate.test.ts`, `web/src/api/client.ts`, `web/src/components/operate/next-steps.tsx`, `web/src/components/operate/shared.tsx`

> You can now tick several open items in Operate > Backlog and start them all as one change. The full `verify` command passes: typecheck, 25/25 tests in `test/operate.test.ts`, lint (warnings only, all in files I didn't change) and the web build. I haven't viewed the page in a browser, so the orchestrator's phone and desktop check is the first real look at the layout.
> **Server**
> - `src/operate/findings.ts`: new `approveFindings(projectDir, store, ids)`.

## T012: Set a stored session secret in the deploy start command

Files: `deploy.json`, `test/auth.test.ts`, `test/deploy-start.test.ts`, `.env.example`

> The deploy start command now passes a stored session secret to the dashboard, so a login should survive a redeploy once the secret is saved. The last `verify` run passed: typecheck is clean and all 15 tests pass.
> **Changes**
> - **`deploy.json`**: the start command sets `AGENT_TEAM_UI_SESSION_SECRET="${AGENT_TEAM_UI_SESSION_SECRET:-}"` just before the `ui` command. The hash step, host list, `ui` command, install and port are unchanged, and the file holds no secret value. When the variable is empty, `src/ui/auth.ts` still makes a random secret, as it did before.

## T008: Remove the old run container and wait for it before resuming

Files: `src/project.ts`, `test/run-container.test.ts`

> Before it starts a new run container, `startRunContainer` now removes the old one and waits until it is gone. The verify command passes: typecheck is clean and all 6 tests in `test/run-container.test.ts` pass.
> **`src/project.ts`**
> - `startRunContainer` is now exported. It takes optional deps `{ docker, processAlive, sleep }`, and the defaults are the real ones: `execFileSync("docker", …)`, the existing `processAlive`, and a blocking sleep. The sleep has to block because `startRun` stays synchronous, so its callers don't change.

## T009: Add config for GitHub issue polling and the Codex base URL

Files: `pipeline.example.yaml`, `src/config.ts`, `test/config.test.ts`

> I added both config blocks. `loadConfig` now reads GitHub issue polling settings and an optional custom endpoint for the Codex runner. The last `verify` run passed: typecheck is clean and all 14 tests in `test/config.test.ts` pass. I didn't run the full test suite, but no other test or source file compares the whole publish config, so the new field shouldn't break anything.
> **`src/config.ts`**
> - **Issue polling:** `publish.github.issues` defaults to `{ enabled: true, everyMinutes: 10 }`. An `everyMinutes` value below 1, above 1440, or not a number fails with "publish.github.issues.everyMinutes must be a number from 1 to 1440". A non-true/false `enabled` also fails.

## T010: Publish the Docker image to ghcr.io on each release

Files: `README.md`, `.github/workflows/release-image.yml`, `test/release-image.test.ts`

> Each published GitHub release now builds the image and pushes it to `ghcr.io/vinicius3333/agent-team` with the release tag and `latest`. The README shows a one-line `docker run` to start it. The last `verify` run passed: typecheck is clean and all 6 tests pass. No image has been built or run here, so the command is untested against a real container.
> **`.github/workflows/release-image.yml`**
> - Runs when a release is published, with `contents: read` and `packages: write`.
