# Branding phase and QA gates: spec

Two changes to the pipeline. The code in `src/` and `web/` is the source of truth; read `src/pipeline.ts`, `src/config.ts`, `src/deploy.ts`, `src/tasks.ts`, `src/store.ts`, and the prompts in `prompts/` before changing them.

## 1. `mockups` becomes `branding`

### Phase order

`spec → architecture → branding → design → plan → build → qa → deploy`

### Branding phase (role: illustrator, runner codex, model gpt-6-astra)

- Outputs, all in `design/branding/`:
  1. `01-logo.png`: the product logo on a plain background, generated first. Every later image uses this logo.
  2. `02-<screen>.png`, `03-<screen>.png`, …: desktop screens only (16:10, 1440×900 style). No mobile images. Pick the main screens from the user stories, most important first.
  3. `README.md`: one line per image: file, what it shows, user stories.
- `config.branding.count` (default 4, range 2 to 6) is the total number of images, logo included.
- Validation: `01-logo.png` exists, at least `count - 1` other images exist, README exists.

### Design phase (role: designer) builds the full design system from the branding images

Outputs:

1. `design/tokens.css`: shadcn/ui variables for Tailwind v4, light and dark, colors pulled from the images (as today).
2. `design/logo.svg`: the logo redrawn as clean SVG from `01-logo.png` (simple geometric shapes, uses `currentColor` or theme colors), plus `design/logo-mark.svg` (symbol only, for the favicon).
3. `docs/design-system.md`: sections `## Principles`, `## Color`, `## Typography`, `## Spacing and radius`, `## Components` (each shadcn component used: variants, states, when to use), `## Icons` (Lucide names), `## Logo`.
4. `docs/design.md`: screens, navigation, states (as today), referencing the design system. Each screen lists its route; the QA phase uses these routes.
5. The planner must add a task that builds a `/design-system` route in the app that renders every token and component in the guide, and a task that installs the logo as favicon and header.

Validation: tokens with `--primary:`, both SVGs parse as XML with an `<svg` root, design-system.md has the headings, design.md exists.

### Compatibility

- `pipeline.yaml`: accept the old `mockups:` key as an alias for `branding:`, and `mockups` in `autonomy.gates` as `branding`.
- Existing state DBs have a `mockups` phase row. Treat it as `branding` when reading (one small migration in `store.ts` that renames the row is fine).
- The dashboard (`web/`) renames the step and tab to "Branding" and reads images from `design/branding/`, falling back to `design/mockups/` for old projects. The server's mockups endpoints follow the same fallback. The New project form's "mockups" toggle and gate become "branding".
- Update `pipeline.example.yaml`, README, and the prompts (`illustrator.md`, `designer.md`, `planner.md`).

## 2. QA phase: automatic gates after the build

Runs after all tasks are merged and before deploy. Skipped for `api` targets only in the visual part (tests still run). Config:

```yaml
qa:
  enabled: true
  maxRounds: 3        # fix rounds before the run stops for a human
```

### Gate 1: tests

Run the project's install and test commands (from `## Commands` in `docs/architecture.md`, as the worker verify flow already parses them, or reuse existing helpers) on a fresh worktree of main, in the same executor type as workers. Failure → the output goes to the QA reviewer as a finding.

### Gate 2: visual

1. Start the app the way deploy does (`deploy.json`: install, start, port), in a container on the agent-team network, without a tunnel. Reuse `src/deploy.ts` pieces; do not duplicate them. Container name `agent-team-qa-<project>`; always removed afterwards.
2. Take screenshots with a Playwright container (`mcr.microsoft.com/playwright` image pinned to a version, arm64 works) on the same network: every route listed in `docs/design.md` plus `/design-system`, at 1440×900, full page. Save to `.agent-team/qa/round-<n>/<route-slug>.png` and record console errors and HTTP status per route in `report.json`.
3. The QA reviewer (new role `qa`, default `{ runner: claude, model: opus }`, read-only tools) gets: test output, the report, and the screenshot paths, plus `design/branding/*.png`, `docs/design-system.md`, `docs/design.md`, `docs/spec.md`. It opens the images and compares layout, colors, typography, logo, and states against the branding and the design system. New prompt `prompts/qa.md`.
4. Its final message is one JSON object: `{"verdict":"pass"|"fail","findings":[{"title","detail","screen"}],"tasks":[<Task objects in the tasks.json schema>]}`. On fail, `tasks` are fix tasks with ids `Q<round><n>` (for example `Q101`), real `allowedPaths`, acceptance criteria, and `verify`. Validate with `validateTasks`.

### Loop

- Pass → deploy.
- Fail → append the fix tasks to `tasks.json` (commit on main), sync the store and GitHub issues, run them through the normal worker + reviewer flow, then run QA again as round n+1.
- After `maxRounds` failures, stop with outcome `failed` and log the last findings. The dashboard can then use the existing "Resume run" button; a resumed run starts a new QA round.
- Store: QA rounds are a phase row `qa` with status, plus meta `qa.round`. Log events with type `qa`.

### Dashboard

- Stepper step "QA" between Build and Deploy.
- A QA section on the project page: rounds, verdict, findings, test output, and the screenshots next to the matching branding image for side-by-side comparison. Server endpoint to list and serve `.agent-team/qa/round-<n>/` images and `report.json` (same path safety rules as the other file endpoints).

## Quality bar

- Match the repo style (no semicolons, double quotes, erasable TS, `.ts` imports).
- Tests in `test/` for: config aliases, phase migration, QA verdict parsing and fix-task validation, and the loop control (use stubs for executors and agents).
- `npx tsc --noEmit`, `npm test`, and `npm run build:ui` pass.
- Never touch containers or networks not named `agent-team-*`.
