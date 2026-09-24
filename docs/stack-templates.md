# Stack templates: spec

Today the architect picks the stack from scratch for every project, and the planner spends `T001` and other foundation tasks on scaffold work. This spec lets the user pick a ready stack template instead: a tested scaffold with fixed commands. The architect designs inside it, the planner skips the scaffold, and deploy, QA, and smoke checks read commands from it instead of guessing. Read `src/pipeline.ts` (`phaseDefinitions`, `phasePrompt`, `runTestGate`, `attemptDeployFix`), `src/deploy.ts` (`detectDeployPlan`), `src/qa.ts` (`parseArchitectureCommands`), `src/smoke.ts`, `src/harness/workspace.ts` (`detectSetupCommand`), `src/project.ts` (`createProject`, `applyChoices`), `src/config.ts`, `src/ui/server.ts` (`parseChoices`), `web/src/pages/new-project.tsx`, and `prompts/architect.md` and `prompts/planner.md` first.

Rules for all items: match the repo style (no semicolons, double quotes, erasable TS, `.ts` imports); add tests with stubs; keep `npx tsc --noEmit`, `npm test`, and `npm run build:ui` passing; log every automatic decision as an event.

## Group A: the template

### A1. Format and location

Templates live in the orchestrator repo at `templates/<name>/`:

```
templates/node-api/
  template.json       manifest
  architecture.md     notes the architect must follow
  scaffold/           files copied into the new project as-is
```

`template.json`:

```json
{
  "name": "node-api",
  "version": 1,
  "title": "Node.js + TypeScript API",
  "description": "Fastify, SQLite, node:test.",
  "targets": ["api"],
  "commands": {
    "install": "npm ci",
    "build": "npm run build",
    "typecheck": "npm run typecheck",
    "test": "npm test",
    "dev": "npm run dev",
    "start": "npm start"
  },
  "port": 3000,
  "sharedPaths": ["package.json", "package-lock.json", "src/app.ts", "src/routes/index.ts"],
  "featureLayout": "src/features/<feature>/**, tests/features/<feature>/**",
  "conventions": ["One folder per feature under src/features.", "Tests next to the feature under tests/features."]
}
```

- `targets`: which of `web`, `api`, `web+api` it serves. The form only offers matching templates.
- `commands.build` and `commands.typecheck` are optional. The rest are required.
- `sharedPaths`: the foundation-only files (planner rule 3). This replaces guessing them from `docs/architecture.md`.
- `scaffold/` must include `package-lock.json`, `deploy.json` generated from the manifest, one passing smoke test, and, for web templates, React + Tailwind CSS v4 + shadcn/ui + Lucide (the stack the designer and workers expect, see `prompts/architect.md`).

Start with three templates: `node-api` (api), `react-vite` (web, static build served with `npx serve`), and `fullstack` (web+api, one Node server serving the API and the built client).

### A2. Loading and validation

New module `src/templates.ts`:

- `listTemplates(): StackTemplate[]` reads `templates/*/template.json`.
- `loadTemplate(name): StackTemplate` validates the manifest (required fields, known targets, `port` is an integer, `scaffold/` exists, `scaffold/deploy.json` matches `commands.install` + `commands.build` and `commands.start`). Throws a clear error listing every problem, like `validateConfig`.
- `templateCommands(dir): TemplateCommands | null` reads `.agent-team/template.json` from a project (see B1), else null.

### A3. Custom / none

`template: custom` (the default) keeps today's behavior exactly: the architect chooses, `T001` builds the scaffold, commands come from `docs/architecture.md` and `deploy.json`. Existing projects have no `template` key and load as `custom`.

## Group B: project creation

### B1. Config and scaffold commit

- `PipelineConfig` gets `template: { name: string; version: number } | null`. `loadConfig` reads `template: <name>` or `template: { name, version }`; `null` or `custom` means none. `validateConfig` checks the template exists and serves `config.target`.
- `createProject` takes `choices.template`. When set, it copies `scaffold/` into the project, writes `.agent-team/template.json` (the manifest plus the version used), and commits both before the brief commit: `chore: start from <name> template v<version>`. Note: `.agent-team/` is gitignored today, so the manifest copy must go to a tracked path instead. Proposal: `stack.json` at the repository root (see open question 1).
- `pipeline.yaml` records `template: { name, version }` so a later run knows what was pinned.

### B2. Form

`web/src/pages/new-project.tsx`: add a **Stack** field under Target. A select with **Custom (architect chooses)** first, then the templates whose `targets` include the chosen target, each with its description. Changing the target resets an incompatible choice to Custom. The list comes from a new `GET /api/templates` in `src/ui/server.ts`. `parseChoices` accepts `template` (string, optional) and rejects an unknown or target-incompatible name with a 400. Add the field to the README form table.

### B3. CLI

`agent-team init <projectDir> --brief <file> [--template <name>] [--target <target>]`. Add `agent-team templates` to list names, targets, and versions. Update `usage` in `src/cli.ts`.

## Group C: planning

### C1. Architect

When a template is set, `phasePrompt` for the architect adds: the template's title, its `architecture.md`, its commands, and the rule "Keep the stack, commands, and shared paths of the template. Design features inside it. Do not replace the framework, test runner, or database. If the spec cannot fit, explain why in an ADR and stop." `stackHints` still apply, but a hint that conflicts with the template loses and is logged as an event.

- The architect still writes `docs/architecture.md`, ADRs, `contracts/openapi.yaml`, and `AGENTS.md`. `## Commands` and `## Stack` must match the template: validation in `phaseDefinitions.architecture.validate` compares the parsed commands with the manifest and rejects a mismatch.
- The architect must not write `deploy.json`: the scaffold owns it. Add this to the prompt branch in `prompts/architect.md` ("If the task prompt names a template...").

### C2. Planner

When a template is set, the planner prompt says: "The scaffold is already committed. Do not add a scaffold task. The foundation-only files are: <sharedPaths>." Change planner rule 1 to: "`T001` is the project scaffold, unless the task prompt says the scaffold is already committed. Then `T001` is the first foundation task (config, data model, or app shell)." `validateTasks` rejects a task whose `allowedPaths` touch `sharedPaths` unless its `phase` is `foundation`.

Expected saving: one to three foundation tasks per project. Measure it (see E2).

## Group D: commands at run time

One resolver replaces the scattered guessing: `resolveCommands(dir): { install, build, test, typecheck, start, port, source }` in `src/templates.ts`, where `source` is `template`, `architecture`, or `detected`. Order: `stack.json`, then `docs/architecture.md` `## Commands` plus `deploy.json`, then today's detection (`detectDeployPlan`, `detectSetupCommand`, `package.json` scripts).

- Deploy: `detectDeployPlan` calls the resolver. `startAppContainer` is unchanged.
- QA: `runTestGate` uses `resolveCommands(dir).install` and `.test` instead of `parseArchitectureCommands` + `hasTestScript`.
- Smoke: `runUiSmoke` and `captureApp` (`src/screenshots.ts`) get the plan from the resolver, so a template project never skips with "the worktree has no deploy.json".
- Workspace setup: the `detectSetupCommand` calls in `attemptTask` and `attemptDeployFix` use `resolveCommands(...).install`.
- `attemptDeployFix`: with a template, the prompt says the start setup comes from the template and the fix must keep `deploy.json` in line with `stack.json`.
- Log one `commands` event per run with the resolved commands and their `source`.

## Group E: versioning and tests

### E1. Versioning

- `version` is a whole number. Bump it on any scaffold or command change. Keep a `CHANGELOG` line in `templates/<name>/architecture.md`.
- Projects pin the version they started from. The orchestrator never rewrites an existing project's scaffold. If `templates/<name>` now has a newer version, the dashboard shows "Template v1 (v2 available)". Upgrading is out of scope.
- If a pinned template is deleted, the project still works: it reads commands from its own `stack.json`.

### E2. Tests

- `test/templates.test.ts`: `loadTemplate` accepts each shipped template and rejects a manifest with a missing command, an unknown target, a missing `scaffold/`, or a `deploy.json` that disagrees with the manifest.
- `resolveCommands`: order of `stack.json`, architecture, detection, with temp dirs.
- `createProject` with a template: scaffold files and `stack.json` land in the first commit; `pipeline.yaml` has the pin.
- `parseChoices`: unknown template and target mismatch give 400.
- `phasePrompt`: architect and planner prompts include the template lines only when a template is set.
- `validateTasks`: a feature task touching `sharedPaths` is rejected.
- CI job (or `npm run test:templates`, not in `npm test` since it needs network): for each template, copy `scaffold/` to a temp dir and run `install`, `typecheck`, `test`, `build`, then `start` and probe the port. This keeps the scaffolds from rotting.

## Implementation order

1. `src/templates.ts`: types, `listTemplates`, `loadTemplate`, validation, and tests.
2. `templates/node-api/` with a passing scaffold, then `react-vite` and `fullstack`. Add the scaffold check script.
3. `resolveCommands` and tests. Switch `detectDeployPlan`, `runTestGate`, `runUiSmoke`/`captureApp`, and the `detectSetupCommand` calls in `attemptTask` and `attemptDeployFix` to it. Behavior for custom projects must not change: existing tests stay green.
4. `src/config.ts`: `template` field, `loadConfig`, `validateConfig`. `pipeline.example.yaml`: `template: custom`.
5. `src/project.ts`: `ProjectChoices.template`, scaffold copy, `stack.json`, first commit, pin in `applyChoices`.
6. `src/pipeline.ts`: template lines in `phasePrompt` for architect and planner; command check in `phaseDefinitions.architecture.validate`; `sharedPaths` check in `validateTasks` (`src/tasks.ts`); `attemptDeployFix` prompt.
7. `prompts/architect.md` and `prompts/planner.md`: the template branches (C1, C2).
8. `src/ui/server.ts`: `GET /api/templates`, `parseChoices`. `web/src/api/client.ts` and `types.ts`, then the Stack field in `new-project.tsx`. Project page shows the template and version.
9. `src/cli.ts`: `--template`, `--target`, `templates` command.
10. README: form table, CLI usage, a short "Stack templates" section.

## Decisions

The open questions below were resolved with the safest simple choice. Other choices made during the build are listed after them.

| Question | Decision |
| --- | --- |
| 1. Manifest location | `stack.json` at the project root, tracked. It is in `orchestratorFiles`, so a worker change to it fails the task, and planner rule 8 forbids it. The deploy fix may not edit it either. |
| 2. Designer and illustrator | They get no template lines. Web templates keep the React + Tailwind + shadcn stack they assume. |
| 3. `stackHints` with a template | Kept and shown in the form as before. An `avoid` hint that names a tool in the manifest's `stack` list is dropped from the prompt and logged as a `template` event. `prefer` hints pass through as tie-breakers. |
| 4. `fullstack` processes | One process: Fastify serves `/api` and `dist/client`, with an `index.html` fallback for client routes. `src/deploy.ts` is unchanged. |
| 5. Architecture gate | Kept. The architect still designs the data model and components. |
| 6. User-provided templates | Not supported. Only `templates/` in this repo. |

Other decisions:

- The manifest has one extra field, `stack` (the tools the template fixes). It drives the hint conflict check.
- `commands.install` is `npm ci --include=dev --no-audit --no-fund`. Deploy runs install and build with `NODE_ENV=production`, and plain `npm ci` would then skip the build tools.
- `react-vite` ships `serve` as a dependency, so `npm start` needs no download at start time.
- Tests: `node-api` uses `node:test` on TypeScript files directly (Node 22.18+ type stripping); `react-vite` and `fullstack` use Vitest.
- Worktree setup uses the template's install command only when `stack.json` exists. Custom projects keep lockfile detection (`detectSetupCommand`), because switching them to the architecture's install command would change today's behavior.
- `resolveCommands` returns `deploy` (install, start, port) instead of separate `start` and `port` fields. For a template, deploy install is `install && build`, which the scaffold's `deploy.json` must equal.
- `validateConfig` accepts a pinned template whose folder is gone when the project has `stack.json`. Without either, loading fails.
- `createProject` checks the template before it creates the folder, so a bad choice leaves nothing behind.
- The form shows every template as a card. Cards for other targets are disabled, and changing the target resets an incompatible choice to Custom. This follows the mockups in `docs/mockups/stack-templates/`.
- The architecture check also rejects a changed `deploy.json`, since the scaffold owns it.
- `npm run test:templates` (`scripts/check-templates.ts`) is the scaffold check. There is no CI config in this repo, so it runs by hand.
- E2 measurement (tasks saved per project) is not built yet. The `commands` event and the planner's task list make it possible to compare runs by hand.

## Open questions

1. Where does the manifest copy live in the project? `.agent-team/` is gitignored, so this spec proposes a tracked `stack.json` at the root. Workers must not edit it: add it to planner rule 8.
2. Do the designer and illustrator need to know the template? Probably not, since web templates keep the React + Tailwind + shadcn stack they assume.
3. Should `stackHints` be hidden in the form when a template is chosen, or kept as tie-breakers for libraries the template does not fix (for example the auth library)?
4. Is `fullstack` one process or two? Deploy runs one container and one port today, so one process is the only option without changing `src/deploy.ts`.
5. Should the architecture gate be skippable with a template? The architect still designs the data model and components, so this spec keeps it.
6. Do we allow user-provided templates (a folder path or git URL), or only the ones in this repo? This spec covers only in-repo templates.
