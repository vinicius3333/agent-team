# App secrets

A generated app often needs keys that only a person can create, such as a Google OAuth client, a payment key, or an email API key. Agents cannot create these accounts. This feature lets the app declare the keys, lets you enter them on the dashboard, and passes them to the live app.

## How it works

1. **The app declares its keys.** The architect lists each third-party key in `.env.example` at the repo root. The task that adds the integration writes the line.
2. **The build uses fakes.** Smoke checks and QA run without the keys. The app must start without them and use a labeled fake, such as a demo sign-in button or a fake checkout.
3. **Deploy waits.** Before deploy, the run compares `.env.example` on `main` with the stored values. If a required key has no value and is not skipped, deploy stops at a gate. The event log shows `phase "deploy" waits for secrets: NAME, ...`, and the notifier sends it as a `gate` notification.
4. **You enter or skip each key.** When the last missing key is saved or skipped, the dashboard resumes the run, and deploy continues.
5. **Deploy passes the values.** The app container gets each value as an environment variable.

## The `.env.example` format

```sh
# Google OAuth client ID. Create a Web client at console.cloud.google.com/apis/credentials.
# Redirect URI: <APP_URL>/api/auth/callback/google
GOOGLE_CLIENT_ID=
# Secret of the same Google OAuth client.
GOOGLE_CLIENT_SECRET=

# optional: Error reports. The app works without it.
SENTRY_DSN=
```

| Rule | Meaning |
| --- | --- |
| `NAME=` line | One secret. Names are upper case letters, digits, and underscores. |
| Comment lines right above it | The description the dashboard shows. A blank line ends it. |
| Comment that starts with `optional` | Deploy does not wait for this key. |
| `<APP_URL>` in a comment | The dashboard replaces it with the live URL. |
| Reserved names | `APP_URL`, `PORT`, `DEMO_EMAIL`, `POSTHOG_KEY`, and the other names agent-team sets itself are ignored. |

## Project and shared secrets

| Scope | Where you enter it | Stored in | Reaches an app when |
| --- | --- | --- | --- |
| Project | Project → Launch → Secrets | `<project>/.agent-team/state.db` | Always, even when `.env.example` does not list it |
| Shared | Settings → Shared secrets | `<runsDir>/.agent-team-secrets.db` | Only when the app's `.env.example` declares it |

A project value overrides a shared value with the same name. Saving a shared value resumes every project whose deploy waits only for it.

## Encryption

- Values are encrypted with AES-256-GCM. The secret's name is bound to its value, so a stored value cannot be moved to another name.
- The key lives only in the host environment, in `AGENT_TEAM_SECRETS_KEY`: 32 random bytes in base64. Make one with `openssl rand -base64 32`.
- The dashboard, the doctor, and each run need the variable. With Docker Compose, put it in `~/.config/agent-team/doctor.env`. Run containers get it from the dashboard by name.
- The API never returns a value. It returns only the name, where the value comes from, and when it changed.
- Deploy passes values to `docker run` through the environment of the docker client, not its arguments, so `ps` does not show them. `docker inspect` on the app container still shows them.

If you change or lose the key, the stored values cannot be read. Deploy then pauses with `Cannot decrypt NAME`. Enter the values again.

## Dashboard

| Place | What you can do |
| --- | --- |
| Build → Overview | While deploy waits, a card lists the missing keys with a field for each one. **Deploy with fakes** skips them all. |
| Launch → Secrets | See every key and its state: Missing, Set, Shared, Optional, or Skipped. Save, replace, override, skip, or remove a key. Add a key the app does not declare. **Redeploy now** restarts the live app with the saved values. |
| Settings → Shared secrets | Save shared values, see which projects use each one, and fill in keys that projects request. |

## API

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /api/projects/:name/secrets` | | Key state, secrets, missing names, whether deploy waits, the live URL |
| `POST /api/projects/:name/secrets` | `{ name, value }` | Saves a project value and resumes the deploy when nothing is missing |
| `POST /api/projects/:name/secrets/delete` | `{ name }` | Removes a project value |
| `POST /api/projects/:name/secrets/skip` | `{ name, skipped }` | Skips a key, or needs it again |
| `POST /api/projects/:name/secrets/redeploy` | | Starts `agent-team deploy` for a live app with no run in progress |
| `GET /api/secrets` | | Shared values, the projects that use them, and the keys projects request |
| `POST /api/secrets` | `{ name, value }` | Saves a shared value and lists the projects it resumed |
| `POST /api/secrets/delete` | `{ name }` | Removes a shared value |

## Limits

- **OAuth needs a stable URL.** A quick tunnel gets a new `trycloudflare.com` address when it restarts. Google checks the redirect URI exactly, so sign-in breaks until you update the client in the Google console. Use a named Cloudflare tunnel with your own domain for apps with OAuth.
- **QA never sees real keys.** QA tests the fakes, not the real provider.
- **A removed value stays in the live app until the next deploy.**

## Older projects

Projects without `.env.example` declare no secrets, so deploy never waits. Projects built before this feature get the gate the first time a change adds `.env.example`.
