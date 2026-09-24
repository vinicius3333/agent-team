# react-vite template

A static web app. Vite builds it to `dist/` and `serve` serves it on `PORT`, with every unknown path falling back to `index.html`.

## Stack

- React 19 and TypeScript.
- Vite for the dev server and the production build.
- Tailwind CSS v4 through `@tailwindcss/vite`. Theme tokens live in `src/index.css`.
- shadcn/ui components in `src/components/ui`, Lucide icons.
- Vitest with jsdom and Testing Library for tests.
- `serve` for production. There is no server code: the app has no backend of its own.

## Layout

- `index.html` and `src/main.tsx`: the entry point.
- `src/app.tsx`: the app shell and the routes. Only foundation tasks edit it.
- `src/index.css`: Tailwind and the theme tokens. The design phase fills in the tokens.
- `src/features/<feature>/`: pages and components of one feature.
- `tests/features/<feature>/`: the tests for that feature.

## Rules

- Keep React, Vite, Tailwind CSS, shadcn/ui, and Vitest. Do not add a server.
- Data that must persist across devices needs an API. If the spec needs one, pick the fullstack template instead.
- Add a router (for example React Router) in a foundation task when the app has more than one page.

## CHANGELOG

- v1: first version.
