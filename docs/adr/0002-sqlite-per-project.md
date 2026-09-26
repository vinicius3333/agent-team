# 0002: One SQLite file per project with node:sqlite

Status: accepted (records the existing app)

## Context

Each project is a folder with a git repo, docs, transcripts, and screenshots. Runs, the dashboard, and the doctor are separate processes on one server that read the same state.

## Decision

- Store run state in `<runsDir>/<project>/.agent-team/state.db` with the built-in `node:sqlite` (`DatabaseSync`) in WAL mode.
- `src/store.ts` owns the schema and creates tables with `CREATE TABLE IF NOT EXISTS`.
- Keep large content (docs, transcripts, images) as files next to the database.

## Consequences

- No database server and no native driver. A project is fully described by its folder, so it is easy to copy, back up, or delete.
- The app is stateful on local disk. It runs on one server and cannot scale out to several app instances.
- Listing projects or incidents across projects means opening many small databases.
- Schema changes rely on `IF NOT EXISTS` and ad hoc column checks, not a migration tool.
