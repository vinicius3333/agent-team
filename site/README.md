# agent-team site

The public landing page for agent-team. It is a separate Vite and React app; the dashboard lives in `web/`.

## Run it

```sh
npm install
npm run dev
```

## Build

| Command | Output |
| --- | --- |
| `npm run build` | `dist/` for a site served at `/` |
| `npm run build:pages` | `dist/` with relative paths, for GitHub Pages under `/agent-team/` |

A push to `main` that changes `site/` deploys it through `.github/workflows/pages.yml`.

## The build animation

The hero animation is a [Remotion](https://www.remotion.dev) composition played with `@remotion/player`.

- `src/build-video/stages.ts` holds the steps, their length in frames, and the example tasks.
- The role orbit reads the active role from the player, so both stay in sync.
- Add `?frame=N` to the URL to open the animation paused on one frame.
- With reduced motion turned on, the player shows the finished app, paused.

Remotion is free for individuals and companies of up to three people. Larger companies need a [company license](https://www.remotion.dev/license).
