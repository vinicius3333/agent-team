# Dashboard login: spec

The dashboard has no login today. Its only defenses are the bind address (`127.0.0.1` unless `--host` says otherwise), the host name allowlist in `allowedHost` (loopback, `*.ts.net`, `AGENT_TEAM_UI_HOSTS`), and the `x-agent-team: 1` header that `handlePost` requires. Anyone who reaches the port can start paid agent runs and read every project file. The Dokploy deploy relies on Caddy basic auth in front of `172.17.0.1`. This spec adds a login inside agent-team so that exposing the dashboard does not depend on a proxy being set up right. Read `src/ui/server.ts` (`startUi`, `allowedHost`, `handlePost`, the `/api/stream` handler), `src/cli.ts`, `web/src/api/client.ts`, `web/src/api/hooks.ts`, `web/src/App.tsx`, `test/dashboard.test.ts`, `Dockerfile`, and `docker-compose.yml` first. Note that `src/access.ts` is about demo logins for the generated apps, not the dashboard; leave it alone.

Rules for all items: match the repo style (no semicolons, double quotes, erasable TS, `.ts` imports); use `node:crypto` only, no new dependencies; add tests with stubs; keep `npx tsc --noEmit`, `npm test`, and `npm run build:ui` passing; log every login, failed login, and lockout to stdout with the client address.

## Approach

One shared password for the whole dashboard. This fits a single user or a small team and needs no user table.

- The operator stores a scrypt hash of the password in an env var, never the password itself.
- A successful login sets a signed, HttpOnly session cookie. The server keeps no session state.
- A reverse proxy that already does the login (Caddy, Authelia, Tailscale) can vouch for the user with a header instead, but only from addresses the operator lists.
- The server refuses to start on a non-loopback address unless one of the two is configured.

Rejected: per-user accounts (needs storage, a UI to manage users, and password resets; not worth it at this size), bearer tokens in `localStorage` (readable by any script injected into the page), OAuth (needs a provider and callback URL per deploy).

## Group A: config

### A1. Env vars

| Var | Meaning |
| --- | --- |
| `AGENT_TEAM_UI_PASSWORD_HASH` | `scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>`. Turns on password login. |
| `AGENT_TEAM_UI_SESSION_SECRET` | At least 32 bytes, base64url. Signs cookies. If unset, the server makes a random one at start, so every restart logs everyone out. Print a notice when that happens. |
| `AGENT_TEAM_UI_SESSION_HOURS` | Session lifetime. Default 168 (7 days). |
| `AGENT_TEAM_UI_TRUSTED_PROXIES` | Comma-separated IPs or CIDRs whose requests may carry the user header. |
| `AGENT_TEAM_UI_PROXY_USER_HEADER` | Header name set by the proxy, for example `Remote-User`. Needs `AGENT_TEAM_UI_TRUSTED_PROXIES`. |
| `AGENT_TEAM_UI_HOSTS` | Unchanged. |

Env only, no `pipeline.yaml` field: auth belongs to the dashboard process, not to a project.

### A2. Auth module

New file `src/ui/auth.ts`. Keep `server.ts` about routes.

- `hashPassword(password): string` and `verifyPassword(password, stored): boolean`. Use `scryptSync` with N=2^15, r=8, p=1, a 16-byte salt, and `timingSafeEqual`. Parse the params from the stored string so they can change later.
- `loadAuthConfig(env): AuthConfig`. Returns `{ mode: "none" | "password" | "proxy" | "password+proxy", ... }`. Throws a clear error for a malformed hash, a secret under 32 bytes, or a user header without trusted proxies.
- `signSession({ user, expiresAt }, secret)` and `readSession(cookie, secret, now)`. Format: `base64url(json).base64url(hmacSha256)`. Reject bad signatures and expired sessions.
- `authenticate(request, config, now): { user: string } | null`. Checks the proxy header first (only if `request.socket.remoteAddress` matches a trusted proxy), then the cookie.
- `createLoginLimiter()`: see C3.

## Group B: server

### B1. Gate every `/api` route

In the `createServer` handler in `startUi`, after `allowedHost` and before `handlePost` and the GET routes: if auth is on and the path starts with `/api/` and is not an `/api/auth/*` route, call `authenticate`. On failure answer `401 { error: "Log in first." }`. This covers `/api/stream/:name` too: `EventSource` sends same-origin cookies, so the stream needs no token in the URL.

Static files (`serveStatic`) stay public. They hold no data, and the SPA needs them to show the login screen.

### B2. Endpoints

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/auth/session` | none | `200 { authenticated, user, mode }`. Never 401. The UI calls it on load. |
| POST | `/api/auth/login` | `{ password }` | `204` with `Set-Cookie`, `401` on a wrong password, `429` with `Retry-After` when limited. |
| POST | `/api/auth/logout` | none | `204`, clears the cookie. |

Cookie: name `agent_team_session`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` from A1, and `Secure` when the request came over HTTPS (direct TLS is not supported, so this means `x-forwarded-proto: https` from a trusted proxy, or a `*.ts.net` host). Rotate nothing on use; the session ends at `expiresAt`.

Logout clears the cookie on that browser only. A stolen cookie stays valid until it expires or the secret changes. See open question 2.

### B3. CSRF

All state changes are POSTs through `handlePost`. Keep the `x-agent-team: 1` header check: a cross-site form cannot set it, and a cross-site `fetch` with it triggers a CORS preflight the server never approves. Add two checks for every POST, including login:

- If `Origin` is present, its host must pass `allowedHost`. Otherwise `403`.
- `SameSite=Strict` on the cookie is the second layer.

No CSRF token is needed on top of these. Keep GET routes free of side effects (they are today).

### B4. Security headers

Add to `send` and `serveStatic`: `x-content-type-options: nosniff`, `referrer-policy: same-origin`, `x-frame-options: DENY`. Do not add a CSP in this change; the Vite build and the office view need checking first.

## Group C: startup and limits

### C1. Refuse unsafe binds

In `startUi`, before `server.listen`: if the host is not `127.0.0.1`, `localhost`, or `::1`, and auth mode is `none`, throw: `Refusing to listen on <host> without a login. Set AGENT_TEAM_UI_PASSWORD_HASH or AGENT_TEAM_UI_TRUSTED_PROXIES, or pass --insecure-no-auth.` `--insecure-no-auth` keeps today's behavior for setups where a proxy does the login but the operator does not want to list it. Print a warning every start when it is used.

This breaks the current `docker-compose.yml`, which binds `172.17.0.1` with no auth. Step 7 fixes it in the same change.

### C2. Loopback stays open by default

On a loopback bind with no auth configured, behave as today. With auth configured, require it on loopback too; an SSH tunnel or Tailscale still ends at loopback and should not skip the login.

### C3. Login rate limit

In-memory, per client address (the socket address, or the first `x-forwarded-for` entry only when the socket address is a trusted proxy):

- 5 failures in 15 minutes locks that address for 15 minutes.
- A global cap of 30 failures per 15 minutes locks all password logins, to slow a spread-out attack.
- A success clears the address's count. Forget entries after the window to bound memory.

Also add a fixed 250 ms delay to every failed login. State is lost on restart; that is fine for this threat level.

## Group D: web UI

### D1. Session check and route guard

- `web/src/api/client.ts`: add `api.session()`, `api.login(password)`, `api.logout()`. `login` and `logout` go through `post`, so they send `x-agent-team`. In `errorFrom` callers, a `401` should dispatch a `window` event `agent-team:unauthorized`.
- New `web/src/api/auth-context.tsx`: `AuthProvider` loads `api.session()` once, listens for `agent-team:unauthorized`, and exposes `{ status: "loading" | "anonymous" | "authenticated", user, mode, refresh }`.
- `web/src/App.tsx`: wrap `ProjectsProvider` in `AuthProvider`, and render `LoginPage` instead of the routes when the status is `anonymous`. Do not mount `ProjectsProvider` or open any `EventSource` before login; `useProjects` would otherwise poll and get 401s.
- `web/src/api/hooks.ts`: on `EventSource` error, call `api.session()` once; if it says anonymous, close the source instead of letting it retry forever.

### D2. Login page

New `web/src/pages/login.tsx`: logo, one password field (`autocomplete="current-password"`), a submit button, and an error line for 401 ("Wrong password.") and 429 ("Too many tries. Try again in N minutes."). Use the existing `Card`, `Button`, and `Input` components and theme tokens. On success call `refresh` and stay on the current URL.

### D3. Log out

Add a "Log out" item to `app-sidebar.tsx`, shown only when `mode` includes `password` and the user did not come through the proxy header.

## Group E: CLI, Docker, and docs

### E1. CLI

In `src/cli.ts`:

- New command `agent-team hash-password`. Reads the password from stdin without echo (TTY) or from a pipe, asks twice on a TTY, and prints the hash line. The command takes no target, so move the `!command || !target` check into the commands that need a target.
- New command `agent-team session-secret`: prints 32 random bytes as base64url.
- `ui` gets `--insecure-no-auth` (boolean). Pass it to `startUi` as `allowInsecureBind`. Update `usage`.
- Add `auth?: AuthConfig` to `UiOptions` so tests can inject it; default to `loadAuthConfig(process.env)`.

### E2. Docker and Dokploy

- `docker-compose.yml`, service `ui`: pass `AGENT_TEAM_UI_PASSWORD_HASH`, `AGENT_TEAM_UI_SESSION_SECRET`, `AGENT_TEAM_UI_TRUSTED_PROXIES`, and `AGENT_TEAM_UI_PROXY_USER_HEADER` through from the environment. Better: load them from `$HOME/.config/agent-team/doctor.env`, which the entrypoint already sources, so the hash and secret stay out of Dokploy. The entrypoint sources that file with `sh`, which expands `$`, so the hash must be in single quotes there (`AGENT_TEAM_UI_PASSWORD_HASH='scrypt$...'`). In a compose `environment:` value it would need `$$`. Prefer the file.
- Keep the bind on `172.17.0.1`. With a password set, C1 passes.
- `Dockerfile`: no change.

### E3. README

Rewrite the Access section: the login, how to make a hash and secret, the proxy option, the loopback default, and `--insecure-no-auth`. Keep the SSH and Tailscale options. Remove "has no login".

## Group F: tests

New `test/auth.test.ts`, plus cases in `test/dashboard.test.ts` using `startUi` with an injected `auth` config and port 0.

- `hashPassword` then `verifyPassword` passes; a wrong password, a changed salt, and a malformed string fail.
- `readSession` rejects a changed payload, a changed signature, and an expired session.
- `loadAuthConfig` throws for a short secret and for a user header without trusted proxies.
- `/api/projects` and `/api/stream/:name` answer 401 without a cookie and 200 with one.
- `/api/auth/session` answers 200 without a cookie.
- Login sets a cookie with `HttpOnly` and `SameSite=Strict`; logout clears it.
- A POST with a foreign `Origin` answers 403, even with a valid cookie and the header.
- The sixth failed login from one address answers 429 with `Retry-After`. Inject the clock.
- The proxy header is ignored from an untrusted address and accepted from a trusted one.
- `startUi` throws on host `0.0.0.0` with no auth, and starts with `allowInsecureBind`.
- Static files and `index.html` load without a cookie.

## Implementation order

1. `src/ui/auth.ts`: hashing, `loadAuthConfig`, session signing, limiter. Unit tests in `test/auth.test.ts`.
2. `src/cli.ts`: `hash-password`, `session-secret`, `--insecure-no-auth`, the `usage` text, and the target check change.
3. `src/ui/server.ts`: `UiOptions.auth` and `allowInsecureBind`, the C1 bind check before `server.listen`, the `/api/auth/*` routes, the gate in the `createServer` handler, the `Origin` check in `handlePost`, and the headers in `send` and `serveStatic`. Tests in `test/dashboard.test.ts`. Update existing dashboard tests to pass `auth: { mode: "none" }` so they keep working.
4. `web/src/api/client.ts` and new `web/src/api/auth-context.tsx`.
5. `web/src/pages/login.tsx`, the guard in `web/src/App.tsx`, the `EventSource` handling in `web/src/api/hooks.ts`, and log out in `web/src/components/app-sidebar.tsx`.
6. README Access section.
7. `docker-compose.yml` env pass-through, and a note in the commit that the operator must add the hash and secret to `doctor.env` before deploying, or the `ui` service will refuse to start. Steps 3 and 7 must ship together.

## Decisions

The open questions were resolved with the safest simple choice:

1. Caddy basic auth: keep it for now. Two logins are a small cost, and the built-in login gets time in production before it faces the internet alone. Remove Caddy basic auth in a later change.
2. Revoking sessions: changing `AGENT_TEAM_UI_SESSION_SECRET` and restarting is enough. No server-side session list.
3. Shared password: acceptable for one user. The README recommends the proxy header mode for teams, so the logs name each person.
4. `*.ts.net` with no auth: no special case. A loopback bind with no login stays open (C2), and the README warns never to use `tailscale funnel` without a login.
5. Read-only access without login: no. Every `/api` route needs the login.
6. `--insecure-no-auth`: keep the flag. The shipped compose file does not pass it, and a flag is visible in the command line.

Small additions made during the build:

- `GET /api/auth/session` also returns `source` (`"session"`, `"proxy"`, or `null`) so the UI can hide "Log out" for proxy users.
- `hash-password` refuses passwords under 12 characters.
- `AGENT_TEAM_UI_TRUSTED_PROXIES` without a user header is allowed only with a password hash (it then only decides whose `x-forwarded-for` and `x-forwarded-proto` to trust). Alone it is a config error.
- A password login's user name is `dashboard`.
- The security headers go on every response, not only `send` and `serveStatic`.

## Open questions (resolved above)


1. Keep Caddy basic auth on the Dokploy deploy after this lands, or remove it? Keeping both means two logins. Removing it puts the dashboard's own login on the internet, which is the point of this work but raises the stakes of C3.
2. Stateless cookies cannot be revoked one by one. Is "change the secret to log everyone out" enough, or do we want a server-side session list (lost on restart unless stored in a new SQLite file)?
3. One shared password means the logs cannot tell team members apart. Is that acceptable, or should the proxy header mode be the recommended path for teams?
4. Should `*.ts.net` hosts still skip auth when no auth is configured? Today a Tailscale `serve` ends on loopback, so C2 already covers it; `funnel` would expose it to the internet.
5. Should read-only access (viewing runs) be possible without login, with login only for POSTs? This spec says no, because project files and transcripts can hold secrets.
6. `--insecure-no-auth`: keep the name, or use an env var only so a compose file cannot flip it by accident?
