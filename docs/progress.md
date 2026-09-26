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
