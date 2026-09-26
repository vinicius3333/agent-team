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
