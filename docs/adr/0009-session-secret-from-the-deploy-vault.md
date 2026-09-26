# 0009: The preview reads its session secret from the deploy secrets vault

## Context

`deploy.json` starts the dashboard with no `AGENT_TEAM_UI_SESSION_SECRET`, so `src/ui/auth.ts` makes a random one at each start and every redeploy logs everyone out (C003, #11). The secret must not be written in `deploy.json`, which is committed.

## Decision

- List `AGENT_TEAM_UI_SESSION_SECRET` in a new `.env.example` as an `optional:` secret, with a comment that says to make it with `agent-team session-secret`.
- The operator stores it once in the project's secrets vault (Settings > Secrets). Deploy already passes stored project secrets to the app container as environment variables.
- The `deploy.json` start command passes `AGENT_TEAM_UI_SESSION_SECRET="${AGENT_TEAM_UI_SESSION_SECRET:-}"` to the `ui` command. When it is empty, the server keeps today's behavior: a random secret and a warning.

## Consequences

- With the secret stored, a login survives a redeploy.
- Smoke checks and QA run without the secret and still start.
- No new storage and no new code path in the vault. Rotating the secret means storing a new value and redeploying, which logs everyone out once.
