<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo/horizontal-dark.svg">
  <img alt="agent-team" src="docs/brand/logo/horizontal-light.svg" width="320">
</picture>

A self-hosted orchestrator that turns a plain-text product brief into a working web app or API. A team of AI agents writes the spec, architecture, mockups, design, and task plan. Scoped worker agents then build the app one task at a time, and a reviewer checks each task.

![A team of agents passing work around the agent-team hexagon](docs/brand/assets/readme-hero.png)

All roles default to Claude. The illustrator uses Codex, because it generates the mockup images. Any role can use any supported runner.

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
| design | Designer | `docs/design.md`, `design/tokens.css` |
| plan | Planner | `tasks.json` |
| build | Worker, then Reviewer | code and tests, one commit per task |

Role prompts live in `prompts/`. Edit them to tune behavior.

State lives in `<projectDir>/.agent-team/`: `state.db` (SQLite) and agent transcripts.

## Live preview

With `deploy.enabled: true`, the orchestrator runs the finished app from `main` in a container and exposes it through a Cloudflare quick tunnel. You get a random public URL such as `https://welding-apps-symphony-registrar.trycloudflare.com`, with no account, domain, or open port.

- How to start the app: `deploy.json` from the architect (`install`, `start`, `port`), else `npm start`, else a static `index.html`.
- The URL goes to the logs, `status`, the dashboard, the GitHub epic, and the repository homepage.
- `agent-team deploy <projectDir>` redeploys; `agent-team undeploy <projectDir>` stops it.
- Quick tunnels have no uptime guarantee, and the URL changes if the tunnel container restarts. For a stable address, use a named Cloudflare tunnel with your own domain.
- Anyone with the URL can reach the app. Do not deploy apps that hold real data.

## GitHub

Set `publish.github.enabled: true` to run the whole process in the open on GitHub:

| Step | What happens |
| --- | --- |
| First merge | Creates the repository (private by default) and the labels. |
| Plan written | Opens an epic issue with the brief, one issue per task (acceptance criteria, scope, verify command, dependencies), and a GitHub Projects board with every issue. |
| Each phase and task | Lands through a pull request (`Closes #N`, reviewer verdict, attempt count), merged on GitHub. Local `main` follows. |
| Failed attempt | Posts the failure reason as a comment on the task issue. |
| Blocked task | Adds the `blocked` label and a comment. |
| Board | Todo, In Progress, and Done follow each task. The epic closes when the build completes. |

It all runs on the host, so GitHub credentials never enter a container. If a GitHub step fails, the orchestrator logs it and merges locally.

One-time host setup: `gh auth login`, `gh auth refresh -h github.com -s project`, and `gh auth setup-git`.

## Harness

The harness runs every agent call. It isolates each attempt, retries infrastructure failures, and falls back to other models.

| Concern | Behavior |
| --- | --- |
| Workspace | Each task attempt gets a fresh git worktree on branch `agent/<task>-<attempt>`, created from `main`. A failed attempt is thrown away and never touches `main`. A passing attempt is rebased on `main` and merged fast-forward. |
| Sandbox | With `harness.isolation: docker`, each agent call and verify command runs in its own container: read-only root, only the worktree writable, all capabilities dropped, CPU, memory, and process limits. The CLIs get copies of their auth files, never the real directories. |
| Network | Agent containers join an internal Docker network with no route out. Their only exit is the `agent-team-proxy` container (tinyproxy), which allows HTTPS to an allowlist: Claude, OpenAI, npm, PyPI, GitHub, plus `harness.network.extraDomains`. |
| Credentials | Containers get copies of `~/.claude/.credentials.json` and `~/.codex/auth.json`. Tokens refreshed inside a container are written back to the host. If `CLAUDE_CODE_OAUTH_TOKEN` is set (from `claude setup-token`), it is passed by name instead. |
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
- Node's built-in `fetch` ignores `HTTPS_PROXY`, so app code that calls outside hosts with raw `fetch` fails inside the sandbox.
- With `isolation: none`, agents run with full access to the machine user. Use that only on a disposable VPS.

## Roadmap

1. CLI MVP: sequential pipeline, both runners (this release)
2. Harness: worktrees, Docker sandbox, retries, fallbacks (done); parallel task scheduler
3. Scope guard hooks inside the agent (network allowlist done)
4. Web control UI and Telegram gate approvals
5. Preview deploy per run

## License

MIT
