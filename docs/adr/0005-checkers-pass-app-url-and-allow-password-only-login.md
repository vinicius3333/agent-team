# 0005: Checkers pass APP_URL and accept a password-only login

## Context

The import baseline (change C001) saw HTTP 403 on every dashboard page and a demo login timeout. The app container in smoke checks, QA, and the baseline got `DEMO_EMAIL` and `DEMO_PASSWORD`, but not `APP_URL`. The browser reached the app by a container name that the dashboard's Host check does not know, so it refused every request. The login checker also always filled an email field, and the dashboard login card has only a password field.

We could fix this in the app (allow any host, or add an email field) or in the checkers.

## Decision

- Fix the checkers. `captureApp` in `src/screenshots.ts` sets `APP_URL` (and `PUBLIC_URL`, `BASE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXTAUTH_URL`, `ORIGIN`) to the URL the browser uses, the same way deploy does. Every run of an app now gets `APP_URL`.
- The login checker (`docker/qa/screenshot.mjs`) fills an email field only when one exists. It always fills the password and submits.
- The dashboard keeps its strict Host, Origin, header, and auth checks, and its password-only login (ADR 0003).

## Consequences

- The dashboard preview passes the baseline without weakening its DNS-rebinding guard.
- Generated apps see `APP_URL` in QA and smoke checks too, so their absolute links work there.
- The login checker works for both password-only apps and email-and-password apps.
