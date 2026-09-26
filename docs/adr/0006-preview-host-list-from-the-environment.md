# 0006: Build the preview host list from the environment

## Context

The dashboard refuses any request whose Host is not loopback, `*.ts.net`, or a name in `AGENT_TEAM_UI_HOSTS`. This blocks DNS rebinding. The preview (`deploy.json`) added only the `APP_URL` host name, with an untested inline `node -p` script. In QA the browser reached the app as `agent-team-qa-agent-team`, got 403 on every route, and the demo login never ran (C002, #1 and #2). The request says to read the extra names from the environment and not to hard-code them.

## Decision

- A pure function `previewHosts(env)` in `src/ui/hosts.ts` builds the list: the names in `AGENT_TEAM_UI_HOSTS`, the host names of the public URL variables (`APP_URL`, `PUBLIC_URL`, `BASE_URL`, `ORIGIN`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`), and `HOSTNAME`. It drops empty values, bad URLs, and duplicates.
- `agent-team preview-hosts` prints that list. The `deploy.json` start command sets `AGENT_TEAM_UI_HOSTS` from it.
- `startAppContainer` starts app containers with `--hostname <container name>`, so `HOSTNAME` is the name QA and smoke checks use.
- The Host, Origin, header, and auth checks do not change.

## Consequences

- QA and the preview can open the dashboard even when `APP_URL` is missing, and the list logic has a unit test.
- The allowed list grows by the app's own container name. Only containers on the same Docker network resolve it, so the rebinding guard still holds.
- Every generated app now sees its container name in `HOSTNAME`. Apps that bind to `HOSTNAME` still work, since the name resolves to the container.
- ADR 0005 still holds: checkers keep passing `APP_URL`.
