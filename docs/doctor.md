# Doctor: error monitoring and self-repair

A long-running `agent-team doctor <runsDir>` process watches every project. When a run stops for a reason a machine can fix, it opens an incident, runs a doctor agent to diagnose and fix it, and resumes the run. Example: on 2026-09-24, `crm-test` task T005 was blocked because `parseVerdict` misread three passing reviews. A doctor should have found the parser bug, fixed it, and resumed the run.

Read `src/pipeline.ts`, `src/project.ts`, `src/store.ts`, `src/harness/*`, `src/github.ts`, `src/ui/server.ts`, and `src/cli.ts` first. Match the repo style (no semicolons, double quotes, erasable TS, `.ts` imports).

## Detection (every 60 s)

For each project in `runsDir`, an incident opens when all of these hold:

- No run is alive (`runAlive`), or a run is alive but no event was logged for `doctor.stallMinutes` (default 45; an agent call still inside its timeout does not count as a stall: check the attempts table or running containers).
- The last stop (`meta run.stop` from B8) is `failed` or `paused`, or the run stalled.
- Not an incident: `completed`; `awaiting_approval` for a configured human gate; a budget stop; a replan that needs a human (these are decisions for the user; open an issue once, but do not act).
- No open incident exists for the same project and the same stop fingerprint (normalized reason). A `paused` stop for a runner cooldown is not an incident until the cooldown has passed and a resume failed again.

## Incident record

`.agent-team/incidents/<timestamp>.json` in the project: fingerprint, stop reason, status (`open`, `diagnosing`, `fixed`, `gave_up`), attempts, cost, actions taken, PR URL, issue URL. Events logged with type `doctor`.

## Doctor agent

- New role `doctor`, default `{ runner: claude, model: opus }`, prompt `prompts/doctor.md`.
- The harness prepares a workspace: a fresh git worktree of the agent-team source clone (see Source clone) on branch `doctor/<project>-<timestamp>`, plus a read-only `.incident/` folder inside it with: run log tail (last 300 lines), `status` output, the stop reason, `tasks.json`, the last 6 transcripts related to the failing subject, and the project's `pipeline.yaml`. The agent runs in the same docker executor as workers (network allowlist on), with edit rights only inside the agent-team worktree (not `.incident/`).
- Its final message is one ```json block:

```json
{
  "diagnosis": "one paragraph",
  "cause": "agent_team_bug" | "project_state" | "external" | "unknown",
  "projectActions": [{ "action": "retry", "taskId": "T005" } | { "action": "reset_cooldowns" } | { "action": "resume" } | { "action": "edit_task", "taskId": "T005", "allowedPaths": ["..."] }],
  "codeFix": true | false,
  "summary": "what changed and why, for the PR body"
}
```

- `edit_task` goes through `validateTasks` and the same landing path as replans, with the same human-gate rules for shared files.

## Code fixes

When `codeFix` is true, the harness (not the agent):

1. Runs `npm ci`, `npx tsc --noEmit`, and `npm test` in the worktree. The agent must add a regression test; reject a fix with no changed file under `test/`.
2. Commits (conventional message, no AI attribution lines), pushes the branch, and opens a PR on the agent-team repo with `gh pr create` (title from the summary, body with diagnosis, incident link, and test output).
3. Hotfix: copies the changed files into the live install the runs use (the directory `src/cli.ts` runs from), so the resumed run uses the fix. Records the PR URL in the incident.
4. Runs the project actions, then resumes the run.
5. When `doctor.autoMerge` is on (default), merges the PR with `gh pr merge --merge --delete-branch` once the resumed run gets past the failing point. A stacked PR waits until GitHub retargets it to `main`. A failed merge gets one issue comment, and a person merges it.

If a later incident's fix touches the same files as an unmerged doctor PR, the new branch is based on that PR's branch.

## Limits

- `doctor.maxAttempts` (default 3) per incident, `doctor.maxUsdPerIncident` (default 15). After the limit: status `gave_up`, comment on the issue, stop acting on that fingerprint.
- One incident is worked at a time across all projects.
- The doctor never deletes projects, never force-pushes, never touches containers or networks not named `agent-team-*`, and merges its own PR only after the resumed run gets past the failing point (`autoMerge: false` turns that off).

## Notifications: GitHub issues

On the agent-team repo (the source clone's `origin`): open one issue per incident, labeled `incident`, with project, stop reason, and key log lines. Comment on it when the doctor diagnoses, opens a PR, resumes, succeeds (the resumed run passes the failing point), or gives up. Close it when the project's run completes after the fix.

## Source clone

The live install on the VPS (`~/agent-team`) is not a git checkout. The doctor uses a separate clone, path from `doctor.sourceDir` (default `~/agent-team-src`), created with `gh repo clone` if missing and fetched before each incident. Document in the README that deploying from a laptop with rsync overwrites hotfixes until their PR is merged and pulled.

## Config

Doctor settings live in `<runsDir>/doctor.yaml` (not in each project), all optional: `stallMinutes`, `maxAttempts`, `maxUsdPerIncident`, `sourceDir`, `repo` (default: the clone's origin), `autoMerge` (default true), `role` (runner, model).

## Dashboard

- A global "Incidents" page in the sidebar: list with project, status, cause, cost, attempts, PR and issue links, and the diagnosis. Detail view with actions taken and transcripts.
- The project page shows an open incident as a banner.
- Server: `GET /api/incidents`, `GET /api/incidents/:project/:id`.

## CLI and service

- `agent-team doctor <runsDir> [--once]`. `--once` checks once and exits, for tests and cron.
- README: how to run it as a systemd user service with `CLAUDE_CODE_OAUTH_TOKEN` in its environment.

## Tests

Stubs for the agent and gh: detection rules (each non-incident case), fingerprint dedup, limits, code-fix rejection without a test change, the JSON contract, and project actions.
