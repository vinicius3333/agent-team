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

## Analytics

- PostHog through `posthog-js`. `src/lib/analytics.ts` starts it only when `VITE_POSTHOG_KEY` is set at build time; the deploy sets it from `operate.posthog.publicKey`. Without the key nothing is sent.
- Page views are captured on every route change.
- Call `track(event, properties)` from `@/lib/analytics` for each core user action in the spec, for example `track("joke_voted", { jokeId })`. Use snake_case, past-tense event names.
- List every event in `docs/analytics.md`, with a `## Funnel` section that names the signup funnel steps in order.

## 3D (optional)

Add this only when the chosen visual style has a real-time 3D hero (the design phase says so in `docs/design.md`).

- Packages: `three`, `@react-three/fiber`, and `@react-three/drei`. Add `@types/three` as a dev dependency.
- Put the scene in `src/features/<feature>/scene/` and load it with `React.lazy`, so the 3D code is its own chunk and never blocks the first paint.
- Show a static poster image first. Keep the poster, and never mount the canvas, when `prefers-reduced-motion: reduce` matches, when WebGL is missing, or on screens under 768px.
- Bundle every model, texture, font, and environment map under `public/` or `src/assets/`. Do not load drei presets or any asset from a CDN: the QA browser has no internet, and a failed request fails the smoke check.
- Clamp the device pixel ratio to `[1, 1.5]`, use `frameloop="demand"` when the scene is still, and stop rendering when the canvas is off screen.
- Keep every headline, link, and button in HTML over the canvas. Never draw text in WebGL.
- Tests: jsdom has no WebGL. Test the fallback logic and mock the lazy scene module.

## CHANGELOG

- v1: first version.
- v2: PostHog analytics with a `track()` helper.
- v3: optional 3D hero with React Three Fiber.
