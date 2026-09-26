# C001: Fix the import baseline failures

## Change
The import baseline started the dashboard and checked it like a visitor would. Three things failed. `npm test` did not pass. Every page (`/`, `/login`, `/new`, `/import`, `/incidents`, `/settings`, and an unknown path) answered HTTP 403. The demo login timed out because the checker found no field to fill. This change fixes those failures. It adds no features and removes none.

What must be true after the change:
- `npm test` exits with code 0 on a clean checkout after `npm ci && npm run build:ui`, with no network, agents, GitHub, or Docker.
- When the preview starts from `deploy.json` with `APP_URL` and `DEMO_PASSWORD` set, a `GET` with the `APP_URL` host header on each of `/`, `/login`, `/new`, `/import`, `/incidents`, `/settings`, and `/not-found` answers HTTP 200 with the dashboard page, not 403.
- A request with a host name that is not loopback, not the `APP_URL` host, and not in `AGENT_TEAM_UI_HOSTS` still answers 403. The Host, Origin, and auth checks stay as strict as they are today.
- The baseline login check can log in to the dashboard with `DEMO_PASSWORD` alone, since the login card has only a password field.

Only `US-02` changes. It gains criteria for the preview host and the demo login.

## New or changed user stories

### US-02: Log in to the dashboard
As an operator, I want to log in with the dashboard password so that only people I trust can start paid agent runs and read project files.

Acceptance criteria:
- When a password hash is set and I am not logged in, every dashboard URL shows the "Log in" card with a password field, and every `/api` route except `/api/auth/*` returns 401.
- Submitting the right password sets an HttpOnly session cookie and shows the page I asked for.
- Submitting a wrong password shows "Wrong password." and keeps me on the login card.
- After 5 wrong passwords from one address, login from that address is locked for 15 minutes, and the card shows "Too many tries. Try again in N minutes."
- When no login is set and the server listens on loopback only, the dashboard opens with no login card.
- When a trusted proxy sends the configured user header from an allowed IP, the dashboard treats that user as logged in.
- When the preview starts with `APP_URL` set, a page request whose host is the `APP_URL` host answers 200 and shows the "Log in" card; a request with any other unknown host answers 403 with "This host name is not allowed. Add it to AGENT_TEAM_UI_HOSTS."
- When the preview starts with `DEMO_PASSWORD` set (12 or more characters), the baseline login check opens `/`, fills the password field with `DEMO_PASSWORD`, submits, and sees the projects list; it does not wait for an email field.

## Out of scope
- New features or changes to any story other than `US-02`.
- User accounts or an email field on the login card. `DEMO_EMAIL` stays unused, as `docs/adr/0003-shared-password-or-trusted-proxy-auth.md` says.
- Loosening the Host, Origin, `x-agent-team` header, or auth checks, for example allowing every host.
- Making real runs work in the preview (it still lacks `claude`, `gh`, Docker, and an agent token).
- Adding CI for `npm test` or the typecheck.

## Open questions
- **Why did `npm test` fail?** The request does not name the failing tests. Default: fix the tests or code that fail, without changing product behavior; if a test checks outdated behavior, update the test to match the spec.
- **Why did every page answer 403?** The only 403 on a page request is the host check. Default: the baseline started the app without the `APP_URL` host in the allowed list (or with a different host). The fix makes the baseline and the preview start the same way `deploy.json` does, so the `APP_URL` host is allowed.
- **Where does the login fix go: the dashboard or the login checker?** The dashboard has only a password field, and the checker timed out on `locator.fill`. Default: keep the password-only card and make the checker (`src/screenshots.ts`) handle a form with no email field. The architect may choose otherwise if the cause is different, as long as no email field or account is added.
- **Is `/not-found` meant to be a real page?** Default: no. It is an unknown path, and it should answer 200 with the dashboard shell, which then shows its own not-found view.
- **Which `/settings` and `/login` routes exist?** Default: both are served by the dashboard shell like every other route, so both answer 200.
