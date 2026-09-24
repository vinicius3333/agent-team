# node-api template

An HTTP API in Node.js and TypeScript. It runs as one process on one port.

## Stack

- Node.js 22.18 or later. It runs TypeScript tests directly (type stripping), so only erasable syntax works.
- Fastify 5 for HTTP routes.
- SQLite through the built-in `node:sqlite` module. No native build step, no ORM.
- `node:test` and `node:assert` for tests. Tests call `app.inject`, so no server has to run.
- `tsc` builds `src/` to `dist/` for production.

## Layout

- `src/server.ts`: starts the app on `PORT` and `HOST`.
- `src/app.ts`: `buildApp(database)` creates the Fastify app. Tests call it with an in-memory database.
- `src/database.ts`: `openDatabase(path)`. The path comes from `DATABASE_PATH`, default `data/app.db`.
- `src/routes/index.ts`: registers every feature. Only foundation tasks edit it.
- `src/features/<feature>/`: routes, queries, and schemas for one feature.
- `tests/features/<feature>/`: the tests for that feature.

## Rules

- Keep Fastify, `node:sqlite`, and `node:test`. Do not add an ORM or another test runner.
- Create tables in a migration function in the feature folder, called from `src/database.ts` by a foundation task.
- Every route that serves a user story sits under `/api`.

## CHANGELOG

- v1: first version.
