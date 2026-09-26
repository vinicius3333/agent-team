# Notifications: tell the user when a run needs them

Today the user learns that a run stopped only by opening the dashboard or reading a GitHub issue from the doctor. A run can wait at a gate for hours. This spec adds push notifications for the moments that need a person, or that a person wants to know about.

Read `src/pipeline.ts` (`runPipeline`, `RunStop`, `noteStop`, `budgetStop`, `runPlanningPhase`, `runDeployPhase`), `src/qa.ts` (`runQaLoop`), `src/store.ts` (`events`, `meta`, `log`), `src/cli.ts` (`run`), `src/doctor.ts` (`loadDoctorConfig`, the GitHub issue notifier, `checkOnce`), `src/incidents.ts`, and `src/ui/server.ts` first. Match the repo style (no semicolons, double quotes, erasable TS, `.ts` imports). Keep `npx tsc --noEmit`, `npm test`, and `npm run build:ui` passing.

## Design

- The event log (`events` table in each project's `state.db`) and the `run.stop` meta record are the source of truth. The pipeline does not call the notifier. A separate loop reads new events and sends notifications.
- Why: a slow or broken webhook can never block or fail a run, and events written while no notifier runs are sent later (up to a cutoff, see Dedup).
- One loop, `checkNotifications(runsDir)`, runs every 15 s. It reads events with an id above the project's cursor, maps them to notifications, sends them, and moves the cursor.

## Events to notifications

Match on the event `type` and message prefix as they are logged today. Where a message is too loose to match safely, add a structured event instead of parsing prose (see step 2).

| Notification | Trigger today | Severity |
|---|---|---|
| `gate` | `log("gate", 'phase "<phase>" is ready for review: ...')` in `runPlanningPhase` | action |
| `gate` | `log("gate", 'phase "deploy" waits for secrets: NAME, ...')` in `runDeployPhase` (see `docs/secrets.md`) | action |
| `budget` | `log("budget", "run budget reached: ...")` in `budgetStop` | action |
| `qa_failed` | `log("qa", "stopped after <n> failed rounds; ...")` in `runQaLoop` | action |
| `paused` | `run finished: paused`, with the reason from `run.stop` | action |
| `failed` | `run finished: failed`, with the reason from `run.stop` | action |
| `stopped` | `log("run", "interrupt received; ...")` in `src/cli.ts` (user or service stop) | info |
| `finished` | `run finished: completed` | info |
| `live` | `log("deploy", "live at <url>; ...")` | info |
| `incident` | doctor opens an incident or gives up (`log("doctor", ...)`) | info / action on give-up |

Rules:

- `run finished: awaiting_approval` is not sent on its own. The `gate`, `budget`, or `qa_failed` event before it already covers it.
- A `paused` stop that the doctor treats as a cooldown (`cooldownPattern` in `src/doctor.ts`) is sent only when `notifications.cooldowns: true`. Default false: the doctor resumes it.
- The re-log of a waiting gate on each resume (`is waiting for approval`) is not sent. Only `is ready for review` is.

## Channels

In build order. Each channel is a function `send(channel, message): Promise<void>` in `src/notify/channels.ts` that throws on failure.

1. **Webhook** (generic). `POST` JSON (see Message) to `url`, with optional `headers`. Optional HMAC: when `secret` is set, add `X-Agent-Team-Signature: sha256=<hex>` over the raw body.
2. **Slack** incoming webhook. `POST { text, blocks }` to the webhook URL. One section block with the title and body, one button to the dashboard link.
3. **ntfy**. `POST` the body to `<server>/<topic>` with headers `Title`, `Priority` (action = `high`, info = `default`), `Tags`, `Click` (dashboard link), and `Authorization: Bearer <token>` when set. Default server `https://ntfy.sh`.
4. **Email** (optional). SMTP through `nodemailer` (new dependency, loaded with a dynamic import only when an email channel exists). Plain-text body plus the link.

Use `fetch` with `AbortSignal.timeout(10_000)` for all HTTP channels. No new dependency for 1 to 3.

## Config

`<runsDir>/notifications.yaml`, next to `doctor.yaml`, so one file covers all projects. Missing file: notifications are off. Loaded by `loadNotificationConfig(runsDir)` with the same validation style as `loadDoctorConfig`.

```yaml
dashboardUrl: https://vps.tailnet.ts.net:4400   # base for deep links; null = no links
cooldowns: false
throttle: { perProjectPerMinute: 6, digestAfter: 3 }
channels:
  - name: phone
    type: ntfy
    topic: agent-team-${NTFY_TOPIC_SUFFIX}
    token: ${NTFY_TOKEN}
    events: [gate, budget, qa_failed, paused, failed, live]
  - name: slack
    type: slack
    url: ${SLACK_WEBHOOK_URL}
    projects: [crm-test]        # optional; default all projects
  - name: hook
    type: webhook
    url: https://example.com/agent-team
    secret: ${WEBHOOK_SECRET}
  - name: mail
    type: email
    smtp: { host: smtp.example.com, port: 587, user: "${SMTP_USER}", password: "${SMTP_PASSWORD}" }   # quote ${...} inside { }: unquoted it is not valid YAML
    from: agent-team@example.com
    to: [you@example.com]
    events: [gate, budget, failed]
```

- `events` defaults to all notification kinds. `projects` defaults to all.
- Unknown `type`, unknown event name, or a missing required field is a config error that names the channel.

## Secrets

- Values of the form `${NAME}` are read from the environment of the process that sends (the `ui` server or the `doctor` service). A missing variable disables that channel and logs one warning. It does not stop the loop.
- Secrets never go into `state.db`, event messages, logs, the dashboard API, or git. The settings API returns channel names, types, and a masked URL host only.
- Webhook URLs for Slack are secrets. Treat `url` as secret for `slack`, and for `webhook` when it has a query string.
- README: add the variables to the systemd unit's `Environment=` lines, as for `CLAUDE_CODE_OAUTH_TOKEN`.

## Message

One shape, built by `buildMessage(project, notification, event, stop)` in `src/notify/message.ts`. Channels only format it.

```json
{
  "kind": "gate",
  "severity": "action",
  "project": "crm-test",
  "title": "crm-test: spec is ready for review",
  "body": "Approve or request changes.",
  "url": "https://.../projects/crm-test?tab=docs&doc=docs/spec.md",
  "at": "2026-09-24T12:00:00.000Z",
  "eventId": 812,
  "costUsd": 12.4
}
```

- Title: `<project>: <short line>`, at most 80 characters. Body: at most 500 characters, first line of the reason plus `keyFailureLines` output for failures. No log dumps.
- Deep links, from `dashboardUrl`: gate to the phase document (`?tab=docs&doc=...`), `qa_failed` to `?tab=qa`, `budget` to the project page (which already offers to raise the budget), `live` to the deploy URL and the project page, `incident` to `/incidents/<project>/<id>`. Confirm the tab names in `web/src/pages/project.tsx`.
- Never include the demo account password. `live` says "the password is on the dashboard", as the deploy event does.

## Dedup and throttling

- Cursor: `meta notify.cursor` per project = last handled event id. Add `store.eventsAfter(id, limit)` (`SELECT id, at, type, message FROM events WHERE id > ? ORDER BY id LIMIT ?`).
- First run with no cursor: set it to the latest event id and send nothing, so enabling notifications does not replay history.
- Stale events: skip events older than 24 h (the notifier was down). Log one summary line instead.
- Dedup key: `<project>:<kind>:<fingerprint(reason)>` using `fingerprint` from `src/incidents.ts`. Do not send the same key twice within 6 h. Keep keys in `meta notify.sent` (JSON map, pruned on write).
- Throttle: at most `perProjectPerMinute` per project. When more than `digestAfter` notifications are due in one pass for one project, send one digest message listing them.
- `action` notifications skip the throttle but not the dedup.

## Failure handling

- The notifier never runs inside the pipeline process, so it cannot block a run.
- Each send has a 10 s timeout. On failure: retry twice with backoff (5 s, 30 s) inside the same pass, then give up on that message.
- The cursor moves forward after the pass whether sends succeed or not. A dead channel does not cause a backlog.
- Record each failure in `meta notify.lastError.<channel>` (time, status, first 200 characters of the error, with secrets masked) and log it with type `notify` in the runs-level log, not the project's event log. Five failures in a row disable the channel until the process restarts or the config changes; the settings page shows it.

## Send test

- `POST /api/notifications/test` with `{ channel }` (or all channels when missing) sends a `test` message and returns `{ channel, ok, error }[]`.
- CLI: `agent-team notify-test <runsDir> [--channel <name>]`.
- Dashboard: a "Notifications" section on the Settings page lists channels (masked), last error, and a "Send test" button per channel.

## Where the loop runs

Default: inside `agent-team doctor` (it is already a long-running service over `runsDir`) and inside `agent-team ui`. Only one may send: take a lock file `<runsDir>/.notify.lock` holding the pid; the other process skips the loop while that pid is alive.

## Tests

`test/notify.test.ts`, with a stub `fetch` and a stub mailer:

- Mapping: each row of the table, plus the non-events (`awaiting_approval`, waiting gate re-log, cooldown pause with `cooldowns: false`).
- Cursor: first run sends nothing; events after the cursor send once; events older than 24 h are skipped.
- Dedup and throttle, including the digest.
- Failure: a timing-out channel does not stop other channels, the cursor still moves, the channel disables after five failures.
- Secrets: `${NAME}` expansion, missing variable disables the channel, masked output in the settings API and logs.
- Message: titles and bodies stay within limits, deep links per kind, no password in `live`.
- Channel payloads: Slack blocks, ntfy headers, webhook HMAC.
- Send test: API and CLI.
- Lock: two loops, one sender.

## Implementation steps

1. `src/store.ts`: add `eventsAfter(id, limit)` and `lastEventId()`.
2. `src/pipeline.ts` and `src/qa.ts`: make the triggers exact. Keep the current messages, and use fixed prefixes the notifier can match: `gate` "is ready for review", `budget` "run budget reached", `qa` "stopped after". Add a constant per prefix, exported from `src/notify/events.ts`, and use it in both places.
3. `src/notify/config.ts`: `loadNotificationConfig(runsDir)`, env expansion, validation.
4. `src/notify/message.ts`: `buildMessage`, deep links, limits.
5. `src/notify/events.ts`: `notificationFor(event, stop, config)` returning the kind or null.
6. `src/notify/channels.ts`: webhook, Slack, ntfy, then email.
7. `src/notify/index.ts`: `checkNotifications(runsDir, deps)` with cursor, dedup, throttle, retries, lock.
8. `src/doctor.ts` (`runDoctor`) and `src/ui/server.ts`: start the loop. `src/cli.ts`: `notify-test` command.
9. `src/ui/server.ts`: `GET /api/notifications`, `POST /api/notifications/test`. `web/src/pages/settings.tsx`: Notifications section.
10. `README.md`: setup, `notifications.yaml` example, env variables in the systemd unit. Add a commented example file `notifications.example.yaml`.
11. `test/notify.test.ts`.

## Decisions

The open questions, resolved with the safest simple choice. Each can change later without a migration.

| Question | Decision | Why |
|---|---|---|
| Incidents on these channels too? | Yes. Opened incidents are `info`, a give-up is `action`. The GitHub issue stays. | A give-up needs a person; the issue alone is easy to miss. Drop `incident` from a channel's `events` to avoid doubles. |
| Login token in links? | No. Links are plain `dashboardUrl` links. | A token in a push message leaks access. The dashboard stays tailnet-only. |
| Send `stopped`? | Supported, but not in the default `events`. | A deploy restarts every run and would send noise. A pause or failure right after an interrupt is not sent either. |
| Loop in `ui` and `doctor`? | Both, with `.notify.lock`. `doctor --once` does not start the loop. | Users without the doctor still get messages; the lock keeps it to one sender. |
| Per-project overrides in `pipeline.yaml`? | Left out. | `projects:` per channel covers muting. |
| `nodemailer`? | Optional and not in `package.json`. Loaded with a dynamic import on the first email send. Without it, the email channel fails with "run npm install nodemailer". | No new dependency for users who do not use email. |

Other choices made while building:

- Channel delivery state (last success, last error, failure count, off flag) lives in `<runsDir>/.notify-state.json`, not in `meta notify.lastError.<channel>`. A channel is shared by all projects, and project `meta` has no runs-level home. The error text is masked before it is written.
- "Runs-level log" means the `ui` or `doctor` process output (journald for the service), with the prefix `[notify]`.
- A channel turns off after 5 failures for the process and config version that saw them. The settings page reads the same file, so it shows the state of the process that sends.
- `gate` dedup includes the event id: each "ready for review" is a new review round (for example after requested changes), so it is never a duplicate. Other kinds dedup on the reason, so the two "live at" lines (pipeline and `deploy`) send once.
- The doctor now logs `incident <id>: gave up: <why>` so a give-up has an event to match.
- `cooldownPattern` moved to `src/notify/events.ts`; the doctor imports it from there. This avoids an import cycle between the doctor and the notifier.
- `buildMessage(project, notification, event, context)`: the stop reason arrives through `notification`, and `context` carries `dashboardUrl` and `costUsd`.
- Title truncation uses "..." instead of "…": `fetch` rejects header values outside Latin-1, and ntfy sends the title as a header. Other non-ASCII characters in ntfy headers become "?".
- Info messages over `perProjectPerMinute` are dropped with a log line. The throttle count is kept in memory.
- Send test tries each channel once, without retries, and also answers for channels that are off because of a missing variable.
- Secrets go in the service's `EnvironmentFile` (mode 600), not in `Environment=` lines of the unit file.
