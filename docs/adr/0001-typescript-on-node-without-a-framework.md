# 0001: TypeScript on Node.js with no server framework

Status: accepted (records the existing app)

## Context

agent-team is a CLI and a dashboard server for one operator. It spawns other CLIs, reads and writes files, and serves a small JSON API. It must install fast on a server and in Docker.

## Decision

- Write the server in TypeScript and let Node.js (>= 22.18) run the `.ts` files directly. There is no server build step.
- Use plain `node:http` with a hand-written router in `src/ui/server.ts`.
- Keep runtime dependencies to one package, `yaml`.
- Test with the built-in `node:test` runner and check types with `tsc --noEmit`.

## Consequences

- Install is small and has no native builds. `npm ci --omit=dev` is enough to run the server.
- Only erasable TypeScript syntax works (no enums or parameter properties), because Node strips types.
- The router, body parsing, and security checks (Host, Origin, CSRF header) are custom code that the team maintains.
- No CI runs the server tests or the type check today.
