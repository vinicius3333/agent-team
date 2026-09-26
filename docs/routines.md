# Routines

A routine is a recurring job you give to one agent. For example, the `marketer` makes Instagram images every week, or the `researcher` scans search terms every two weeks. Each routine has a budget cap and writes its output inside the project.

The three Operate agents (monitoring, analytics, research) are built-in routines. You manage all routines on **Operate > Routines**.

The prototypes are in `docs/mockups/routines/`.

## What a routine has

| Field | What it means |
| --- | --- |
| `id` | A slug, such as `weekly-social-posts`. The dashboard makes it from the name. |
| `name` | The title on the card. |
| `role` | The agent: `marketer`, `researcher`, `pm`, or `designer`. The role sets the runner, the model, and the tools. |
| `instructions` | What the agent does, in your words. |
| `trigger` | When it runs (see below). |
| `everyDays` | Days between runs, for the `interval` trigger only. `0.25` is every 6 hours. |
| `output` | Where the result goes (see below). |
| `budgetUsd` | The most one run may spend, from 0 to 10. |
| `enabled` | The switch on the card. |

```yaml
routines:
  monthlyUsd: 40
  list:
    - { id: monitoring, enabled: true, trigger: interval, everyDays: 1 }
    - { id: analytics, enabled: true, trigger: interval, everyDays: 1 }
    - { id: research, enabled: true, trigger: interval, everyDays: 7 }
    - id: weekly-social-posts
      name: Weekly social posts
      role: marketer
      instructions: Make 3 square Instagram images for the week's top jokes. Use the brand colors.
      trigger: interval
      everyDays: 7
      output: marketing
      budgetUsd: 2
      enabled: true
```

## What each role can do

The role decides the tools. You cannot pick tools per routine.

| Role | Runner by default | Can use |
| --- | --- | --- |
| `marketer` | codex | Image generation, web search |
| `researcher` | claude | Web search |
| `pm` | claude | Read code, web search |
| `designer` | claude | Read code |

Marketing images need a role on the codex runner, because codex has the image generation tool. The config check rejects a `marketing` routine on a claude role.

## Triggers

| Trigger | When it runs |
| --- | --- |
| `interval` | `everyDays` after its last run started. A new routine runs as soon as the app is live. |
| `sprint` | After a sprint finishes (its change merged and the build run stopped, so the app is redeployed). |
| `deploy` | After the app goes live again. |
| `manual` | Only when you click **Run now**, or run `agent-team routines <dir> --run <id>`. |

A `sprint` or `deploy` routine only follows events after the doctor first sees it. A new routine does not fire on an old deploy.

The doctor checks every project once a minute. A scheduled routine starts when all of these hold:

- it is on, and its trigger is due
- the app is live
- no build run is alive, and the routine is not running already
- the routines of the last 30 days spent less than `routines.monthlyUsd` minus its budget

**Run now** skips the switch, the trigger, and the live check. The money cap and the build-run rule still apply. Due routines of one project run one at a time.

## Outputs

Routines write only inside the project. They never post to social media or send anything out. Code changes go to the backlog, and a sprint builds them.

| Output | What the server does with the reply |
| --- | --- |
| `backlog` | Adds up to 5 findings with source `routine`. The evidence starts with `[<routine name>]`. The next sprint weighs them. |
| `report` | Writes `docs/routines/<id>.md` and commits it. |
| `marketing` | Copies up to 6 images to `marketing/routines/<id>/` and commits them. The card shows the last 3. |

### How a marketing routine runs

1. The server makes a stage folder in the system temp folder. It copies the brand files the project has into `context/`: `input.md`, `docs/spec.md`, `docs/design-system.md`, the logos, `design/tokens.css`, and `marketing/copy.json`.
2. The agent runs in the stage folder. It saves images in `out/` and lists them in its reply.
3. The server keeps only `.png`, `.jpg`, and `.webp` files inside `out/`, up to 15 MB each. It drops the rest and logs why.
4. The server copies the kept images into the project, commits them, and removes the stage folder.

The agent never writes to the project folder itself.

## Money

- `budgetUsd` caps one run. The claude runner enforces it. Codex does not report cost, so a codex run counts its full `budgetUsd` toward the monthly cap.
- `routines.monthlyUsd` (default 40) caps all routine runs of the last 30 days, the built-in ones included. A built-in run counts its reported cost, or $1 when there is none.
- The Routines view shows the 30-day spend and lets you change the cap.

## Built-in routines

The monitoring, analytics, and research agents keep their own data gathering and prompts (see [operate.md](operate.md)). As routines, only these fields apply to them:

- `enabled`
- `trigger`: `interval` or `manual`
- `everyDays`

`operate.enabled: false` still turns them off, and the health probe with them. Custom routines do not depend on `operate.enabled`.

### Projects from before routines

A `pipeline.yaml` with `operate.schedule` and no `routines` block keeps working. Each schedule in hours becomes `everyDays` (hours / 24), and `0` turns that routine off. The first save from the Routines view writes the `routines` block and removes `operate.schedule`.

## Commands and views

- `agent-team routines <dir>`: lists the routines, their triggers, their last runs, and the 30-day spend.
- `agent-team routines <dir> --run <id>`: runs one routine now and exits 1 when it fails.
- **Operate > Routines**:
  - filter chips by output
  - one card per routine, with the switch, capabilities, the last images, the schedule, the last run, its cost, and **Run now**
  - **New routine** opens a side sheet with templates (marketing images, market research, SEO audit, custom)
  - a click on a card's name opens the same sheet to edit or delete it

## Where things are

| Piece | File |
| --- | --- |
| Config, migration, and checks | `normalizeRoutines` and `routineProblems` in `src/config.ts` |
| Scheduling, runs, and outputs | `src/routines.ts` |
| Runs table | `routine_runs` in `src/store.ts` |
| Doctor tick | `operateTick` in `src/operate/tick.ts` |
| Prompt | `prompts/routine.md` |
| Routes | `GET` and `POST /api/projects/<name>/routines`, `POST /api/projects/<name>/routines/run` in `src/ui/server.ts` |
| View | `web/src/components/operate/routines.tsx`, `routine-sheet.tsx` |
