# 0003: Shared password or trusted proxy for dashboard auth

Status: accepted (records the existing app)

## Context

The dashboard can start paid agent runs and read every project file. It serves one operator or a small trusted team. There is no sign-up and there are no roles.

## Decision

- Support three modes in `src/ui/auth.ts`: no login on loopback only, one shared password (scrypt hash in `AGENT_TEAM_UI_PASSWORD_HASH`), or a trusted proxy that sends a user header.
- Sessions are HMAC-signed, HttpOnly, `SameSite=Strict` cookies. `Secure` is set only when the request came over HTTPS through a trusted proxy or `*.ts.net`.
- Lock one address after 5 failures in 15 minutes, and all logins after 30 failures.
- Refuse a non-loopback bind without a login unless `--insecure-no-auth` is passed.
- Check Host, Origin, and an `x-agent-team: 1` header on requests.

## Consequences

- No user table, no password reset, no per-user audit trail.
- Changing the password means making a new hash and restarting.
- The orchestrator's `DEMO_EMAIL` and `DEMO_PASSWORD` cannot seed a user. `deploy.json` hashes `DEMO_PASSWORD` into the shared password at startup instead, and it must be at least 12 characters.
