# C001 architecture: fix the import baseline failures

This change adds no screens and no endpoints. It fixes how the orchestrator's own checkers start and log in to an app, and it fixes failing tests.

## Changes

### 1. Every page answered 403: the checker never set `APP_URL`

Cause, found in the code:

- `captureApp` in `src/screenshots.ts` starts the app container with `demoAccessEnv(...)` only. It does not pass `APP_URL`. Smoke checks, QA screenshots, and the import baseline all use `captureApp`.
- The `deploy.json` start command sets `AGENT_TEAM_UI_HOSTS` from `new URL(process.env.APP_URL).hostname`. With no `APP_URL`, that command fails quietly and the extra host list is empty.
- The browser container reaches the app at `http://<alias or container name>:<port>`. That host is not loopback, not `*.ts.net`, and not in the list, so `allowedHost` in `src/ui/server.ts` answers 403 on every request.

Fix:

- `captureApp` passes the public URL env to the app container, built from its own `baseUrl`: `{ ...publicUrlEnv(baseUrl), ...demoAccessEnv(...) }`. Export `publicUrlEnv` from `src/deploy.ts` (or move it to `src/access.ts`) so both callers share it. The rule in the architect prompt says the orchestrator sets `APP_URL` in every run of the app. Now QA and smoke checks do that too, not only deploy.
- `allowedHost`, `allowedOrigin`, and the auth checks in `src/ui/server.ts` stay as they are. No wildcard host and no new bypass.
- `deploy.json` stays as it is.

Tests:

- `test/screenshots.test.ts` (or the existing smoke/QA test): check that the env passed to `startAppContainer` has `APP_URL` equal to `http://<alias>:<port>`. Use a fake for `startAppContainer` or test a small pure helper that builds the env. No Docker.
- `test/dashboard.test.ts` (or `test/auth.test.ts`): start the server with `AGENT_TEAM_UI_HOSTS=app.example`. `GET /` with `Host: app.example` answers 200. `GET /` with `Host: evil.example` answers 403 with "This host name is not allowed. Add it to AGENT_TEAM_UI_HOSTS." Also check `/login`, `/new`, `/import`, `/incidents`, `/settings`, and `/not-found` answer 200 with the dashboard shell (`index.html`) when the host is allowed. Skip the shell check if `web/dist` is missing, since `npm test` also runs before `build:ui` in some setups.

### 2. The demo login timed out: the checker required an email field

Cause: `docker/qa/screenshot.mjs` always calls `email.fill(...)` on the first email or text field. The dashboard login card has only a password field, so the fill waits 10 seconds and fails.

Fix, in the checker, not the app:

- In `screenshot.mjs`, look for the email field. Fill it only when it exists and `login.email` is set. Always fill the password field and submit. The success check stays the same: after submit, the page leaves the login card.
- Keep the email-and-password flow working for generated apps that have accounts.
- Change the failure text in `src/screenshots.ts` (`loginFailures`) from "the demo account (DEMO_EMAIL, DEMO_PASSWORD)" to "the demo account" only if a test pins it; otherwise leave it.
- The dashboard login card does not change. No email field, no accounts (ADR 0003).

Tests: `screenshot.mjs` runs only inside the QA image, so add no browser test. If the fill logic moves into a small exported helper, test that helper with a fake locator.

### 3. `npm test` failed

The baseline did not say which tests failed, and this design phase could not run the suite. The worker must:

1. Run `npm ci && npm run build:ui && npm test` in `node:24-bookworm`, with no network, and no `git` identity, `claude`, `gh`, or Docker set up. That is how the baseline runs it.
2. Fix each failure at its cause. Likely causes to check first:
   - Tests that run `git commit` in a temp repo without a user name and email. Set them per repo in the test (`git -c user.name=... -c user.email=...`) or through env (`GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME`, and the email pair), as `test/doctor.test.ts` and `test/import.test.ts` already do.
   - Tests that expect `docker`, `gh`, or `claude` on `PATH`, or read `$HOME` config. Replace them with fakes or temp folders.
   - Tests that read `web/dist` or a network address.
3. Change product code only when the test shows a real bug. If a test checks outdated behavior, update the test to match `docs/spec.md`.

Done means `npm test` exits 0 in that clean container.

### Files touched

- `src/screenshots.ts`: pass `APP_URL` and friends to the app container.
- `src/deploy.ts` or `src/access.ts`: export the shared `publicUrlEnv` helper.
- `docker/qa/screenshot.mjs`: email field is optional.
- `test/*.test.ts`: new host tests and the fixes for failing tests.
- No change to `src/ui/server.ts`, `src/ui/auth.ts`, `web/`, `deploy.json`, or `contracts/openapi.yaml`.

## New dependencies

None.

## Data migrations

None. No schema change.

## Risks

- Passing `APP_URL` to QA and smoke containers changes what generated apps see there. That is the intended contract: generated apps already get `APP_URL` on deploy and must build absolute links from it. Now their QA links point at the checker's internal host, which the browser can reach.
- Making the email field optional could let a login check "pass" on a page that needs an email but has none that matches the selector. The success check still requires leaving the login card, so a real failed login still fails.
- The cause of the test failures is not confirmed. If a failure comes from real product behavior, the fix may touch a feature module. Keep any such fix inside the story it belongs to and note it in `docs/progress.md`.
