# fullstack template

One Node.js process serves the JSON API under `/api` and the built React client for every other path. The deploy platform runs one container on one port, so the client and the API ship together.

## Stack

- Node.js 22.18 or later and TypeScript.
- Fastify 5 for the API. `@fastify/static` serves `dist/client` and falls back to `index.html` for client routes.
- SQLite through the built-in `node:sqlite` module.
- React 19, Vite, Tailwind CSS v4, shadcn/ui, and Lucide for the client.
- Vitest for both sides: server tests call `app.inject`, client tests use jsdom and Testing Library.
- `npm run build` runs `vite build` (client to `dist/client`) and `tsc` (server to `dist/server`).

## Layout

- `server/server.ts`: starts the app on `PORT` and `HOST`.
- `server/app.ts`: `buildApp(database)`. Tests call it with `openDatabase(":memory:")`.
- `server/database.ts`: `openDatabase(path)`, path from `DATABASE_PATH`, default `data/app.db`.
- `server/routes/index.ts`: registers every API feature. Only foundation tasks edit it.
- `server/features/<feature>/`: API routes and queries of one feature.
- `client/src/app.tsx`: the client shell and routes. Only foundation tasks edit it.
- `client/src/features/<feature>/`: pages and components of one feature.
- `tests/server/` and `tests/client/`: tests, one folder per feature.

## Rules

- Keep one process. Do not split the client into its own server.
- Keep Fastify, `node:sqlite`, React, Vite, Tailwind CSS, shadcn/ui, and Vitest.
- Every API route sits under `/api`, so it never clashes with a client route.

## CHANGELOG

- v1: first version.
