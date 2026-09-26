Fix the problems the import baseline found, without changing features:

- tests failed (npm test)
- / answered HTTP 403
- /login answered HTTP 403
- /new answered HTTP 403
- /import answered HTTP 403
- /incidents answered HTTP 403
- /settings answered HTTP 403
- /not-found answered HTTP 403
- the demo account (DEMO_EMAIL, DEMO_PASSWORD) could not log in at /: locator.fill: Timeout 10000ms exceeded.
