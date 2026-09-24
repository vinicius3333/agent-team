# agent-team

A self-hosted orchestrator that turns a plain-text product brief into a working web app or API. A team of AI agents writes the spec, architecture, design, and task plan. Scoped worker agents then build the app one task at a time, and a reviewer from a different model vendor checks each task.

Planning roles default to Claude. Workers default to Codex. Any role can use any supported runner.

## Requirements

- Node.js 22.18 or later (runs TypeScript directly, uses built-in `node:sqlite`)
- git
- The `claude` CLI (Claude Code), logged in
- The `codex` CLI, logged in

## Install

```sh
npm install
```

## Usage

1. Write your idea in a file, for example `brief.md`.
2. Create a project:

   ```sh
   node src/cli.ts init ~/projects/my-app --brief brief.md
   ```

   This creates the folder, runs `git init`, writes `input.md`, and copies `pipeline.example.yaml` to `pipeline.yaml`. Edit `pipeline.yaml` to choose models, gates, and budget.
3. Run the pipeline:

   ```sh
   node src/cli.ts run ~/projects/my-app
   ```

   The run stops at each gate listed in `autonomy.gates`. Read the artifact, then approve it and run again:

   ```sh
   node src/cli.ts approve ~/projects/my-app spec
   node src/cli.ts run ~/projects/my-app
   ```

4. Check progress and cost:

   ```sh
   node src/cli.ts status ~/projects/my-app
   ```

5. Retry a blocked task after you fix the cause:

   ```sh
   node src/cli.ts retry ~/projects/my-app T007
   ```

## Pipeline

| Phase | Role | Output |
| --- | --- | --- |
| spec | PM | `docs/spec.md` |
| architecture | Architect | `docs/architecture.md`, `docs/adr/*`, `contracts/openapi.yaml` |
| design | Designer | `docs/design.md`, `design/tokens.json` |
| plan | Planner | `tasks.json` |
| build | Worker, then Reviewer | code and tests, one commit per task |

Role prompts live in `prompts/`. Edit them to tune behavior.

State lives in `<projectDir>/.agent-team/`: `state.db` (SQLite) and agent transcripts.

## Harness

The harness runs every agent call. It isolates each attempt, retries infrastructure failures, and falls back to other models.

| Concern | Behavior |
| --- | --- |
| Workspace | Each task attempt gets a fresh git worktree on branch `agent/<task>-<attempt>`, created from `main`. A failed attempt is thrown away and never touches `main`. A passing attempt is rebased on `main` and merged fast-forward. |
| Sandbox | With `harness.isolation: docker`, each agent call and verify command runs in its own container: read-only root, only the worktree writable, all capabilities dropped, CPU, memory, and process limits. The CLIs get copies of their auth files, never the real directories. |
| Setup | Each fresh worktree installs dependencies first (`npm ci`, `pnpm`, or `yarn`, detected from the lockfile). |
| Failure classes | `rate_limit`, `auth`, `unavailable`, `missing_binary`, `timeout`, `aborted`, `agent_failure`. Only runner output (stderr, error events) is classified, never the agent's own work. |
| Retry | `unavailable` retries the same model with exponential backoff (`transientRetries`, `backoffMs`). |
| Fallback | `rate_limit`, `auth`, `missing_binary`, and `timeout` move to the next entry in the role's `fallbacks`. |
| Cooldown | A rate-limited runner rests for `cooldownMs` (4x after an auth error) and is skipped meanwhile. When every runner rests, the harness waits up to 1 hour, then pauses the run. |
| Attempts | Infrastructure failures pause the run without using up a task's attempts. Only agent failures count toward `maxRetries`. |
| Stop | Ctrl+C stops the agents, kills their containers, and removes worktrees. Run again to resume. Exit code 75 means paused. |

Commands: `agent-team reset-cooldowns <projectDir>` clears runner cooldowns after you fix a login.

## Limits

- Tasks still run one at a time.
- Containers use Docker's default network, with no allowlist yet.
- With `isolation: none`, agents run with full access to the machine user. Use that only on a disposable VPS.

## Roadmap

1. CLI MVP: sequential pipeline, both runners (this release)
2. Harness: worktrees, Docker sandbox, retries, fallbacks (done); parallel task scheduler
3. Network allowlist and scope guard hooks
4. Web control UI and Telegram gate approvals
5. Preview deploy per run

## License

MIT
