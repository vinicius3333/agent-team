Sprint 1: QA and the preview can open the dashboard and log in, and saving the lead settings keeps full access

The preview shows the Log in page to QA and preview visitors instead of a JSON 403 error. The demo account can log in and see the projects list. QA fails a round where no page renders. Saving the Lead settings keeps the lead's full access.

Preview host check (#1): the deploy.json start command adds only the APP_URL hostname to AGENT_TEAM_UI_HOSTS, so the QA host (for example agent-team-qa-agent-team) gets 403 on /, /login, /new, /import, /incidents and /settings. Make the preview start command also allow the host names QA and the preview use, taken from the environment rather than hard-coded. Do not remove the Host check or weaken it in general. It works when a GET to / on the QA host answers 200 with the Log in card and an unknown host still gets 403. Add a test for how the allowed host list is built.

Demo login (#2): once the host is allowed, the US-02 check fills the password field with DEMO_PASSWORD and sees the projects list. Make sure the password hash from DEMO_PASSWORD matches what the login form expects. It works when the QA login step passes without a timeout.

QA verdict (#6): a QA round where every route fails (for example all 403 or 5xx, or no page renders) must not pass, even if the failures are filed as 'preexisting'. Update the verdict logic in the QA module so this case fails with a plain message such as 'No page rendered. Check the host and start command.' Add a test in test/qa.test.ts.

Lead settings keep access (#3): parseLeadSettings and saveLeadSettings in src/lead-actions.ts write only actions, autoApply and chatBudgetUsd, so saving on /projects/:name deletes 'access: full' from pipeline.yaml. Read and write lead.access, keep any other lead keys the form does not manage, and show the access level in the Lead settings form (limited or full, with one sentence on what full allows). It works when a save with access full leaves 'access: full' in pipeline.yaml. Add a round-trip test.

Out of scope: getting the app live and showing the Live badge (#4), sprint mode and routines checks (#5), any change to auth, sessions or lockouts, and new features.

Backlog items:
- #1 [evaluator, high] Preview rejects the QA host with 403 on every route
- #2 [evaluator, high] Demo login check cannot log in to the preview
- #6 [evaluator, low] QA passes rounds where every route fails
- #3 [evaluator, medium] Saving lead settings drops lead.access
