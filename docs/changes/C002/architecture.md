# C002 architecture: let QA and the preview log in, fail empty QA rounds, and keep lead access

This change adds no screens and no new endpoints. It changes one existing form (Lead settings gets an access field), one request body (`POST /api/projects/{name}/lead-settings`), the `deploy.json` start command, and the QA verdict. The Lead settings field reuses the existing card and shadcn/ui controls, so the design phase does not need to run again.

## Changes

### 1. Preview host list (#1, US-02)

What the code does today:

- `deploy.json` builds `AGENT_TEAM_UI_HOSTS` with an inline `node -p` one-liner: the old `AGENT_TEAM_UI_HOSTS` plus the `APP_URL` host name. Nothing tests it.
- `captureApp` in `src/screenshots.ts` sets `APP_URL=http://<alias or container name>:<port>` (C001). The browser reaches the app by that name. But the app container's own name is not in the list unless `APP_URL` reached the start command, and a run that starts the app another way (an older orchestrator, a missing `APP_URL`) gets 403 on every route.
- `startAppContainer` in `src/deploy.ts` does not set `--hostname`. So Docker sets `HOSTNAME` to the short container ID, not the name QA uses.

Fix:

- New module `src/ui/hosts.ts` with two pure functions:
  - `parseHostList(value: string | undefined): string[]`: split on commas, trim, lower-case, drop empty values and duplicates. `src/ui/server.ts` uses it for `extraHosts` in place of its inline split. Behavior stays the same.
  - `previewHosts(env: Record<string, string | undefined>): string[]`: the union, in this order, of
    1. `parseHostList(env.AGENT_TEAM_UI_HOSTS)`,
    2. the host name of each public URL variable the orchestrator sets (`APP_URL`, `PUBLIC_URL`, `BASE_URL`, `ORIGIN`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`), skipped when unset, empty, or not a valid URL,
    3. `env.HOSTNAME`, when it is a valid host name (letters, digits, dots, and hyphens).
    
    It returns names lower-cased, with no port, no empty entries, and no duplicates. No host name is hard-coded.
- New CLI subcommand `agent-team preview-hosts` in `src/cli.ts`. It prints `previewHosts(process.env).join(",")` and nothing else. Add it to the usage text.
- `deploy.json` start replaces the `node -p` one-liner with `AGENT_TEAM_UI_HOSTS="$(node --disable-warning=ExperimentalWarning src/cli.ts preview-hosts)"`. The hash step and the `ui` command stay the same. `install` and `port` stay the same.
- `startAppContainer` in `src/deploy.ts` adds `--hostname <name>` to `docker run`, so `HOSTNAME` inside the app equals the container name the checker uses (for example `agent-team-qa-agent-team`). Skip the flag when the name is not a valid host label (over 63 characters, or characters other than letters, digits, and hyphens). This helps every generated app, not only agent-team, and changes nothing else.
- `allowedHost`, `allowedOrigin`, `knownHost`, and the auth checks do not change. Loopback, `*.ts.net`, and the list stay the only allowed hosts. An unknown host still gets 403 with "This host name is not allowed. Add it to AGENT_TEAM_UI_HOSTS."

Tests:

- `test/hosts.test.ts` (new): `previewHosts` for a set of environments:
  - empty env gives `[]`;
  - `AGENT_TEAM_UI_HOSTS=" a.example, ,A.example"` gives `["a.example"]`;
  - `APP_URL=http://agent-team-qa-agent-team:4400` gives `["agent-team-qa-agent-team"]`;
  - `HOSTNAME=agent-team-qa-agent-team` with no `APP_URL` gives the same;
  - `APP_URL=not a url` and `HOSTNAME=""` are skipped;
  - all set with overlaps gives each name once.
- `test/deploy.test.ts`: the `docker run` args from `startAppContainer` hold `--hostname <name>` for a normal name and leave it out for a 70-character name. Use the existing fake `run`, or export a small `appRunArgs` helper if there is none. No Docker.
- `test/dashboard.test.ts` (or `test/auth.test.ts`): start the server with `AGENT_TEAM_UI_HOSTS` set to `previewHosts({ HOSTNAME: "agent-team-qa-agent-team" }).join(",")` and a password hash. `GET` on `/`, `/login`, `/new`, `/import`, `/incidents`, and `/settings` with `Host: agent-team-qa-agent-team:4400` answers 200. `GET /` with `Host: evil.example` answers 403. When `web/dist` exists, the 200 body is the dashboard shell (the Log in card is drawn by the client).

### 2. Demo login (#2, US-02)

The hash step already matches: `printf %s "$DEMO_PASSWORD"` sends no newline, and `readPiped` in `src/cli.ts` strips at most one trailing newline. The login check already fills only the password field (C001). The login failed because the host check answered 403 first, so change 1 fixes it.

Guard it with a test in `test/auth.test.ts` (or `test/cli.test.ts`): run `node src/cli.ts hash-password` with stdin set to a 12+ character password and no trailing newline, then check `verifyPassword` (or the helper `src/ui/auth.ts` uses for login) accepts exactly that password and rejects the password plus a space. Run it with `execFileSync` and `input`; it runs offline. Do not change the login form, sessions, or lockouts.

### 3. QA fails a round where no page renders (#6, US-05)

Today `splitFailures` in `src/baseline.ts` can file every broken route as "preexisting" on an imported project. Then `hardFailures` is empty and a "pass" verdict stands.

Fix:

- Add to `src/qa.ts`:
  - `export const noPageRenderedMessage = "No page rendered. Check the host and start command."`
  - `export function noPageRendered(visual: VisualReport | null): boolean`. It returns false when `visual` is null (API target, no visual gate). It returns true when `visual.startError` is set, or `visual.routes` is empty, or every route failed. A route failed when it has an `error`, its `status` is null, its `status` is 403 or 500 and up, or it has no screenshot `file`. One route with a 2xx or 3xx status and a screenshot is enough to return false.
- In `src/pipeline.ts`, in the QA round, after `splitFailures`, push `noPageRenderedMessage` onto `hardFailures` when `noPageRendered(visual)` is true. It is added after the split, so the import baseline can never mark it "preexisting". The existing check at the verdict step already rejects a "pass" while a hard failure exists, and the reviewer prompt already lists hard failures, so the reviewer must answer "fail" with a fix task. Log `round N: ${noPageRenderedMessage}`.
- Do not change `splitFailures` or `createBaseline`.

Tests in `test/qa.test.ts`:

- every route 403: `noPageRendered` is true;
- every route has `status: null` and an `error`: true;
- `startError` set with no routes: true;
- one route 200 with a file and the rest 403: false;
- `visual` null: false.

### 4. Lead settings keep access (#3, US-06)

Today `parseLeadSettings` returns only `actions`, `autoApply`, and `chatBudgetUsd`, and `saveLeadSettings` replaces the whole `lead` node with that object. So `access` and any other `lead` keys are lost.

Fix in `src/lead-actions.ts`:

- `parseLeadSettings` also reads `access`. It must be one of `leadAccessModes` (`read` or `full`), or a 400 with "access must be read or full." When the body has no `access`, it leaves `access` out, so an older client does not change it.
- `saveLeadSettings` sets each managed key on its own with `document.setIn(["lead", key], value)` for `actions`, `autoApply`, `chatBudgetUsd`, and `access` (only when given). It never replaces the `lead` node, so other keys and comments stay. The validate-and-restore step and the commit stay the same.
- Stored values stay `read` and `full`. The form shows `read` as "Limited" (ADR 0007).

Dashboard:

- `web/src/api/types.ts`: add `access?: "read" | "full"` to the lead settings type.
- `web/src/components/project/lead-settings-card.tsx`: add an "Access" field with two choices, "Limited" (`read`, the default when unset) and "Full". Under it, one sentence: "Full access lets the lead edit any file and run any command in the project folder, with no review." Use the shadcn/ui `RadioGroup` or `Select` already in `web/src/components/ui/`. Send `access` with the other fields. It must fit at 360px wide.

Contract: `contracts/openapi.yaml` gives `POST /api/projects/{name}/lead-settings` a real request schema with `actions`, `autoApply`, `chatBudgetUsd` (required) and `access` (`read` or `full`, optional).

Tests in `test/lead-actions.test.ts` (or the existing lead test):

- a temp project whose `pipeline.yaml` has `lead: { access: full, note: keep }`; save settings with `access: "full"`: the file still has `access: full` and `note: keep`, and `loadConfig` reads `access` as `full`;
- save with `access: "read"`: the file has `access: read`;
- save with no `access`: the old value stays;
- `access: "admin"` gives a 400.

Set `user.name` and `user.email` in the temp repo, since the save commits.

## New dependencies

None. The server still uses only Node built-ins plus `yaml`. The dashboard uses controls it already has.

## Data migrations

None. `pipeline.yaml` keeps the same keys and values. Projects that lost `lead.access` in an earlier save fall back to `read` until the operator picks "Full" again.

## Risks

- **A wider host list.** `HOSTNAME` adds one name: the app's own container name. Only containers on the same Docker network can resolve it, and loopback is already allowed. Public DNS cannot point a hostile page at it, so the DNS-rebinding guard still holds. We do not add wildcards or skip the check.
- **`--hostname` on every app container.** A few frameworks read `HOSTNAME` as the bind address (Next.js standalone does). The container name resolves to the container's own address, and `HOST=0.0.0.0` is set too, so the app stays reachable. If a generated app breaks, drop the flag and keep the `APP_URL` path, which already covers QA.
- **The live orchestrator must run the new code.** The QA host is chosen by the orchestrator that runs QA. Until it runs this version, `HOSTNAME` is still the container ID; the `APP_URL` path from C001 still covers QA then.
- **QA rounds that used to pass may now fail.** That is the goal. A round fails only when no route renders, so an app with one working page is not affected.
- **Spec wording.** The spec says the form writes `access: limited`. We keep `read`, because `loadConfig` and existing projects use it. The form says "Limited" (ADR 0007).
