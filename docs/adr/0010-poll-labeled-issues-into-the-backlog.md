# 0010: Poll labeled GitHub issues into the backlog

## Context

C003 (#7) asks to turn GitHub issues with the `agent-team` label into change requests or backlog items, and to comment on each issue with a link. A change request starts a paid run at once. A webhook needs a public endpoint and a GitHub secret, and the dashboard often sits behind Tailscale.

## Decision

- Each labeled issue becomes one open backlog item (a finding with `source: github`), never a change request. The maintainer approves it or starts it by hand.
- The long-lived doctor polls with the `gh` CLI every `publish.github.issues.everyMinutes` (default 10). No webhook.
- The finding's fingerprint is `github-issue:<owner>/<repo>#<number>`, so a second poll adds nothing.
- The comment is posted once and recorded in meta `github.issue.<number>.commented`. The link is built from `APP_URL`; with no `APP_URL`, the comment has no link.
- Code lives in `src/operate/issues.ts` with `gh` injected, so tests use a fake.

## Consequences

- No agent spends money because of an issue until a person approves it.
- New issues show up within one poll interval, not at once.
- Polling uses the host's `gh` login and its rate limit; one `issue list` call per project per interval is small.
- Closing or relabeling the issue later is not synced.
