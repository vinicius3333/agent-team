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
