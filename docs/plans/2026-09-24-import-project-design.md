# Import an existing project

## Goal

Bring a project that agent-team did not build into agent-team. After the import, the project behaves like a finished build: you use **Request a change** for all further work.

## Input

The **Import project** form and `agent-team import <dir> --from <git-url|path> [--url <url>...]` take:

| Field | What it does |
| --- | --- |
| Project name | Folder name, as for a new project. |
| Source | A git URL (cloned) or a local folder (copied with `git clone`, so the original never changes). |
| Extra URLs | Optional. Live site, docs, design files. The importer reads them. |
| GitHub | `source` (issues and pull requests on the source repository), `new` (a new repository, as today), or `none`. |
| Approval gates | Any of spec, architecture, design, baseline. |

## Pipeline

`input.mode: import` runs these phases, then marks the run complete with an empty `tasks.json`.

| Phase | Role | Output |
| --- | --- | --- |
| research | `importer` (new, read-only, web fetch) | `docs/import/research.md`: product, users, stack, routes, commands, and what the extra URLs say |
| spec | PM, adopt mode | `docs/spec.md` for the app as it is |
| architecture | Architect, adopt mode | `docs/architecture.md` with `## Commands`, `deploy.json`, `AGENTS.md` |
| design | Designer, adopt mode | `design/tokens.css` and `docs/design-system.md` from the existing CSS; `docs/design.md` with `Route:` lines |
| baseline | orchestrator | runs install, test, and start; screenshots every route into `design/branding/`; writes `.agent-team/import/baseline.json` |

Branding, marketing, plan, and build do not run. The baseline screenshots replace the branding images as the QA reference.

The `researcher` role name is taken by Operate, so the new role is `importer`.

## Baseline

`baseline.json` holds:

- `app`: install and start result, with error lines.
- `tests`: the names of failing tests, or the exit code and a summary when the output cannot be split by test.
- `routes`: HTTP status, console errors, and mobile failures per route.
- `commit`: the `main` SHA the baseline ran on.

The baseline never blocks the import. Failures show as warnings.

## QA against the baseline

With a baseline, QA fails a round only on a regression: a test that passed, a route that loaded, or an app that started. Earlier failures become `preexisting` findings. They show on the QA tab and create no fix tasks. Without a baseline, QA works as today. After a change merges with a QA pass, the baseline updates.

## Cleanup change

When the baseline has failures, the import stores a suggested change ("fix the N failing tests and routes X, Y"). The dashboard shows **Start cleanup change** and **Dismiss**. It never starts on its own.

## GitHub

- `source`: at import, check push access with `gh`. Without it, stop before research and say why. No project board or epic. Issues and pull requests per change. Changes reach `main` only through the pull request.
- `new`: as today; push the imported history.
- `none`: local git only.
- A local folder with no remote cannot use `source`.

## Errors

| Situation | Behavior |
| --- | --- |
| Clone or copy fails | The import does not start; the form shows the error. |
| An extra URL cannot be read | The importer notes it and goes on. |
| research or an adopt phase fails | The phase stops as today and can resume. |
| The app does not start | Warning; `app.ok: false`. Change QA only checks it did not get worse. |
| No tests | Empty `test` command, warning; QA runs screenshots only. |
| Monorepo or stack the container cannot run | The architect notes the limit in `docs/architecture.md`; the baseline records a warning. |

## Tests

- Unit tests for `baseline.json` and the regression comparison in QA.
- Fixture tests for adopt mode: a small Node repository with and without failing tests.
- An eval: import a known app, then run a small change.

## Out of scope

- Private non-GitHub repositories that need credentials.
- Data and migrations of the imported app.
