# C003 architecture: reliable resume, a published image, GitHub issue intake, working sprints and deploy, and custom Codex endpoints

This change adds no new screens and no new endpoints. Two screens get small additions that reuse existing components: the marketing site's `#install` section gets a first step (the existing code block and copy button), and the project page shows the deploy failure reason in the existing live/deploy area. So the design phase does not need to run again.

## Changes

### 1. Wait for the old run container before resuming (#10, US-05)

What the code does today: `startRunContainer` in `src/project.ts` runs `docker rm <name>` without `-f` and ignores every error. A container that is still running (or still being removed by `--rm`) survives, and the next `docker run --name <name>` fails with a name clash.

Fix, in `src/project.ts`:

- Split the Docker calls out behind a small injectable function, so tests can pass a fake: `startRunContainer(projectDir, logPath, image, command, deps = { docker, processAlive, sleep })`. Export it (or export a helper `replaceRunContainer(name, deps)` that it calls).
- Before `docker run`:
  1. `docker inspect --format {{.State.Pid}} <name>`. If it fails, there is no old container; go on.
  2. If the container exists and the store's `run.pid` is alive (`processAlive`), throw `new Error("A run for this project is still going. Stop it before you resume.")`. The dashboard already refuses a second run, so this is a guard.
  3. Otherwise run `docker rm -f <name>`, then poll `docker inspect <name>` every 250 ms until it fails (the container is gone), for at most 30 seconds. On timeout, throw `new Error("The old run container <name> did not go away. Remove it with: docker rm -f <name>")`.
  4. Only then call `docker run`.
- `runContainerArgs` does not change.

Test: `test/run-container.test.ts` gets a case with a fake `docker` that records calls. The old container exists, its run is dead, and `inspect` keeps finding it for two polls. The recorded order must be `inspect`, `rm -f`, `inspect` (found), `inspect` (found), `inspect` (missing), `run`. A second case: the run is alive, so no `rm` and no `run` happen and the call throws.

### 2. Publish a Docker image on each release (#8, US-01)

- New workflow `.github/workflows/release-image.yml`:
  - `on: release: types: [published]`.
  - `permissions: contents: read, packages: write`.
  - Steps: `actions/checkout@v4`, `docker/setup-buildx-action@v3`, `docker/login-action@v3` to `ghcr.io` with `${{ github.actor }}` and `${{ secrets.GITHUB_TOKEN }}`, `docker/metadata-action@v5` for `ghcr.io/vinicius3333/agent-team` with the tags `type=raw,value=${{ github.event.release.tag_name }}` and `type=raw,value=latest`, then `docker/build-push-action@v6` with `context: .`, `file: Dockerfile`, `push: true`.
  - Build `linux/amd64` and `linux/arm64` (the production host is arm64).
  - It runs no tests. Other CI stays out of scope.
- Test `test/release-image.test.ts`: parse the workflow with `yaml` and check that `on.release.types` holds `published`, the file names `ghcr.io/vinicius3333/agent-team`, and the build step uses `Dockerfile` with `push: true`. It runs offline.
- Site (`site/src/`): the `#install` section's first step is:
  ```
  docker run -d --name agent-team -p 4400:4400 -v agent-team-runs:/data ghcr.io/vinicius3333/agent-team:latest
  ```
  Use the command the image actually supports. The worker reads `Dockerfile` and `docker/entrypoint.sh` and adjusts the flags (port, volume, `CLAUDE_CODE_OAUTH_TOKEN`, login hash) so the command starts the dashboard. It uses the existing `code-block` and `copy-button` components. The other install steps stay after it. `npm --prefix site run lint` and the site build must pass.
- `README.md` gets the same one-line start.

### 3. Turn labeled GitHub issues into backlog items (#7, US-07)

New module `src/operate/issues.ts`:

- `issueFingerprint(repo, number)` returns `github-issue:<owner>/<repo>#<number>`.
- `syncIssues(options: { projectDir, store, config, gh, appUrl, now })`. `gh` is an injected function `(args: string[]) => string` that runs the `gh` CLI; tests pass a fake.
  - Skip when `publish.github.enabled` is false, or the project has no repo (no `github.repo` meta and no `origin` remote on github.com), or `publish.github.issues.enabled` is false.
  - List: `gh issue list --repo <owner>/<repo> --label agent-team --state open --json number,title,body,url --limit 100`.
  - For each issue, look for a finding with its fingerprint. If none, add an open finding with `source: "github"`, `severity: "medium"`, `title` = issue title (cut to `backlogTitleMaxLength`), `evidence` = issue URL, `proposal` = issue body (cut to 8,000 characters). Use the same store call the backlog form uses (`addBacklogItem` or the findings insert in `src/operate/findings.ts`), passing the fingerprint.
  - Comment once: after the finding exists, if meta `github.issue.<number>.commented` is not set, run `gh issue comment <number> --repo <owner>/<repo> --body <text>` and then set the meta. This makes a crash between the insert and the comment safe, and a second poll never comments twice.
  - Comment text: `agent-team added this issue to the backlog of <project> as item #<id>: <link>`. The link is `<appUrl>/projects/<project>/operate/next-steps#finding-<id>`, with `appUrl` from `APP_URL` (trailing slash removed). When `APP_URL` is not set, the text ends at `item #<id>.` with no link. Never a localhost default.
  - Log `[issues] <project>: added N, commented N` to stdout. A `gh` failure logs one line and skips this project until the next poll.
- The dashboard's backlog list must render `id="finding-<id>"` on each item so the link lands on it. The worker checks the real route in `web/src/pages/project.tsx` and uses it; the path above is the intent.

Polling:

- `issuesTick({ runsDir, now })` in `src/operate/issues.ts` runs `syncIssues` for each project whose last poll (meta `github.issues.polledAt`) is older than `publish.github.issues.everyMinutes`.
- The long-lived doctor loop in `src/doctor.ts` calls it next to `sprintTick`. `--once` does not poll.

Config in `src/config.ts`, under `publish.github`:

```yaml
publish:
  github:
    issues:
      enabled: true      # poll open issues labeled agent-team
      everyMinutes: 10   # 1 to 1440
```

The label is always `agent-team`. `loadConfig` rejects `everyMinutes` outside 1 to 1440 with a plain message.

Test `test/issues.test.ts`, with a fake `gh` and a temp project store:

- Two labeled issues give two open findings with the right title, evidence URL, and fingerprint, and two comments whose text holds the finding link built from `appUrl`.
- A second `syncIssues` call adds nothing and comments nothing.
- A crash after the insert (fake `gh issue comment` throws once) leads to exactly one comment on the next poll.
- No `appUrl` gives a comment with no URL.
- A project with `publish.github.enabled: false` makes no `gh` call.

### 4. Make sprints and routines work on this project (#5, US-07)

The request does not say why they fail. Known facts from the code:

- `sprintBlocker` in `src/sprint.ts` needs `deploy.enabled`, a finished build (`buildComplete`), no open change, no live run, and room in `sprints.monthlyUsd`. An imported project may never have a finished build in its store, or may keep an open change after a failed merge.
- The Sprints list shows only rows in the `sprints` table. A routine whose output is findings does not create a sprint row.

Work, as one task that diagnoses first:

1. Add `agent-team sprint <projectDir> --check` and `agent-team routines <projectDir> --check` (or a `--dry-run` flag on the existing commands). They print the blocker from `sprintBlocker` and `routineBlocker` for each item, in plain words, and exit 0. This also lets the operator see the cause.
2. Run them against a copy of this project's state (a fixture made from the import: phases approved, `deploy.enabled: true`, no `deploy.url`). Fix each blocker found in code, not in the live project's database. Likely fixes:
   - `buildComplete` must accept an imported project whose phases the importer marked approved.
   - A change stuck in `open` after its run ended must not block sprints forever; `syncSprint` closes it as `failed` with a reason when no run is alive.
   - A sprint that starts with no live app deploys first (see change 5), instead of judging "not deployed".
3. Surface the blocker: when the operator starts a sprint or a routine and it is blocked, the API answers 409 `{ "error": "<blocker>" }`, and the dashboard shows it as a toast. Today some paths return quietly.

Tests:

- `test/sprint.test.ts`: from an imported-project fixture with approved findings, `sprintBlocker` returns null, and `runSprint` with fake runners and a fake deploy creates a sprint row that ends `done` or `failed` (a final state), never stays `planning`.
- `test/routines.test.ts`: `runRoutine` for `monitoring` with a fake runner records `lastRun` and adds its findings; a routine with `output: sprint` adds a sprint row.

### 5. Deploy when it is enabled, and say why when it fails (#4, US-05)

What the code does today:

- `runDeployPhase` in `src/pipeline.ts` marks the deploy phase `approved` with no URL while `deploy.enabled` is false. When the operator later turns deploy on, only a full run with built tasks reaches `runDeployPhase` again. A sprint plans (in `src/improve.ts`) before its change deploys, so its report reads `deploy.url` while it is empty and says "not deployed".
- A failed deploy writes the reason only to the event log.

Fix:

- New `ensureDeployed(context)` in `src/pipeline.ts`: when `deploy.enabled` is true and either `deploy.url` is empty or the app container is not running, it calls `runDeployPhase` (reset the phase to `pending` first when it is `approved` with no URL). Call it:
  - at the start of a sprint run, before the evaluator judges the live app;
  - at the end of a run or change whose tasks were all landed already (the docs-only change path and a resume with nothing to build).
- `deployProject` saves the last failure in meta `deploy.error` as one sentence plus what to do next, for example "The app did not answer on port 4400. Check the start command in deploy.json, then run: agent-team deploy <projectDir>." A good deploy clears it. The secrets wait sets it to "Waiting for secrets: X, Y. Enter or skip them in Settings > Secrets."
- `src/improve.ts`: both report lines use `store.meta("deploy.url") || null` (an empty string is "not deployed" too) and add the reason: `The live app: not deployed (<deploy.error>)`.
- `GET /api/projects/{name}`: the `deploy` object gains `error: string | null` from `deploy.error`. The project page shows it in one line under the Live badge area when there is no URL. Add the field to `web/src/api/types.ts`.

Tests:

- `test/pipeline.test.ts` (or `test/deploy.test.ts`): with the deploy phase `approved`, no URL, `deploy.enabled: true`, and a fake `deployProject`, `ensureDeployed` calls deploy once and sets `deploy.url`; with a fake failure it sets `deploy.error` and leaves the URL empty.
- `test/sprint.test.ts`: the sprint report holds the live URL after a fake deploy, and holds the reason after a fake failure.

Checking the live result (a `GET` on the preview URL answers 200, the Live badge shows) is for QA and the operator on this server. The task that builds this change runs the tests only.

### 6. Fixed session secret in the deploy command (#11, US-02)

- New `.env.example` at the repo root:
  ```
  # optional: signs dashboard login cookies, so a login survives a redeploy. Make one with: agent-team session-secret
  AGENT_TEAM_UI_SESSION_SECRET=
  ```
  The project's deploy secrets vault (`src/secrets.ts`) stores the value. Deploy already passes every stored project secret to the app container as an environment variable (`appSecretEnv`), so no new storage is needed.
- `deploy.json` start adds `AGENT_TEAM_UI_SESSION_SECRET="${AGENT_TEAM_UI_SESSION_SECRET:-}"` before the `ui` command. The value itself is never in the file. When it is empty, `src/ui/auth.ts` makes a random secret and logs its existing warning, so smoke checks and QA still start. `install` and `port` stay the same.
- It is `optional:` so the deploy does not wait for it. The operator runs `agent-team session-secret` once and pastes the output into Settings > Secrets for this project.
- Test in `test/deploy-start.test.ts`: the start command names `AGENT_TEAM_UI_SESSION_SECRET` and reads it from the environment (`$AGENT_TEAM_UI_SESSION_SECRET`); `deploy.json` holds no 43-character base64url string; `.env.example` lists the name with an empty value. A second test in `test/auth.test.ts`: a cookie signed by one `createAuth` with secret S is accepted by a new `createAuth` with the same S (a redeploy), and refused with a different secret.

### 7. OpenAI-compatible endpoint for the Codex runner (#9, US-03)

Config in `src/config.ts`, a new top-level block:

```yaml
runners:
  codex:
    baseUrl: https://openrouter.ai/api/v1   # optional; unset = the normal OpenAI endpoint
    apiKeyEnv: OPENROUTER_API_KEY           # name of the env var that holds the key; never the key
```

- `loadConfig` checks: `baseUrl` must parse as a URL with `http:` or `https:`, or it fails with "Set codex base URL to a full http or https URL." `apiKeyEnv` must match `^[A-Za-z_][A-Za-z0-9_]*$` (same rule as `operate.posthog.apiKeyEnv`). `apiKeyEnv` without `baseUrl` is an error. Because `loadConfig` runs before any agent starts, a bad value stops the run first.
- `src/runners/codex.ts`: when `baseUrl` is set, add to the args:
  ```
  -c model_provider="agent-team"
  -c model_providers.agent-team={ name = "agent-team", base_url = "<baseUrl>", env_key = "<apiKeyEnv>", wire_api = "chat" }
  ```
  The key never goes on the command line; Codex reads it from the environment by name. Without `baseUrl`, the args are the same as today.
- `RunRequest` gains `codex?: { baseUrl: string; apiKeyEnv: string | null }`, filled from config where runners are called.
- Docker sandbox (`src/harness/docker.ts`): when a Codex run has `apiKeyEnv`, pass it as a bare `-e <NAME>` (copies the host value without putting it in the command line), like `CLAUDE_CODE_OAUTH_TOKEN`. Local runs inherit the environment already.
- Egress allowlist (`src/harness/network.ts`): add the `baseUrl` host (and port) to the allowed domains for the run. A `localhost` or `127.0.0.1` URL inside the sandbox cannot reach the host; `docs/architecture.md` says to use the host's LAN or Tailscale name.
- If the key env var is named but unset at run start, fail with "Set <NAME> in the environment for the codex base URL." before the agent starts.
- The key must never be logged. Do not log the args object as-is if it could ever hold values; it does not, by design.

Tests in `test/runners.test.ts` with a fake executor:

- With `baseUrl` and `apiKeyEnv`, the args hold the provider config with that URL and that env name, the key value is not in the args, and the transcript and events hold no key value.
- Without `baseUrl`, the args equal today's args.
- `test/config.test.ts`: `ftp://x`, `not a url`, and `apiKeyEnv: "sk-123 abc"` fail with the messages above.

## New dependencies

- None in the server or the dashboard.
- The new release workflow uses standard GitHub Actions: `actions/checkout@v4`, `docker/setup-buildx-action@v3`, `docker/setup-qemu-action@v3` (for arm64), `docker/login-action@v3`, `docker/metadata-action@v5`, `docker/build-push-action@v6`.

## Data migrations

- No schema change. New meta keys: `deploy.error`, `github.issues.polledAt`, `github.issue.<number>.commented`. Findings from issues use the existing `fingerprint` column.
- New config keys (`publish.github.issues`, `runners.codex`) are optional with defaults, so existing `pipeline.yaml` files still load.
- Existing projects whose deploy phase is `approved` with no URL get deployed by `ensureDeployed` on their next run or sprint.

## Risks

- **Container removal:** `docker rm -f` kills a container. The guard checks that the run is not alive first. A wrong `run.pid` could still remove a live run's container; the pid check matches what the dashboard already trusts.
- **Image size and secrets:** the image holds `claude` and `codex` CLIs but no credentials. The workflow uses only `GITHUB_TOKEN`. Anyone can pull a public image, so it must never bake a token in.
- **Issue intake spends nothing but can spam the backlog:** anyone who can add the label can add items. Items stay open until the maintainer approves them, so no agent runs on their own.
- **Comment link:** without `APP_URL` on the doctor, the comment has no link. Production sets `APP_URL` in `doctor.env`.
- **Diagnose-first work (#5):** the real cause may be in project state, not code. The task fixes code and adds `--check` so the operator can see what still blocks; the live check is done by QA and the operator.
- **Custom endpoints:** a model on another provider may not support every Codex feature (image generation, tool calls). The illustrator and marketer need image generation; keep them on OpenAI unless the endpoint supports it.
- **Session secret:** a leaked stored secret lets someone forge a session. It lives only in the encrypted vault and the container env, never in the repo or logs.
