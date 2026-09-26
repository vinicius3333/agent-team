Wait for the old run container before resuming

In startRunContainer, if a container with the run's name exists and its run is no longer alive, remove it with `docker rm -f` and wait until `docker inspect` no longer finds it before calling `docker run`. Add a case to test/run-container.test.ts.

Publish a Docker image and one-command start

Add a GitHub Actions workflow that builds the Dockerfile and pushes it to ghcr.io on each release. Make `docker run` with that image the first step in the site's install section.

Turn labeled GitHub issues into change requests

For projects with a GitHub repo, poll open issues that carry an `agent-team` label and add each new one as a change request or backlog item. Then comment on the issue with a link to the item.

Sprint mode and routines fix not verified

The user asked to 'ajuste o projeto para que o modo sprint funcione, e as rotinas também'. Progress entries L001–L006 do not show a change that makes sprints or routines run on this project. Starting a sprint from the approved findings and running a routine should work and show up in the sprints list.

App deploy enabled but no live app

The user asked twice to turn on deploy. pipeline.yaml now has deploy.enabled: true, but the sprint reports 'The live app: not deployed'. The project page should show the Live badge and a working preview URL.

Set a fixed session secret in the deploy command

Add AGENT_TEAM_UI_SESSION_SECRET to the deploy's start command in deploy.json, taken from a stored secret made once with `agent-team session-secret`, so sessions survive a redeploy.

Allow an OpenAI-compatible model endpoint for agents

Pass a configurable base URL and API key from pipeline.yaml to the Codex runner so it can use any OpenAI-compatible endpoint, such as OpenRouter or a local vLLM or Ollama server.

Backlog items:
- #10 [monitoring, medium] Wait for the old run container before resuming
- #8 [research, medium] Publish a Docker image and one-command start
- #7 [research, medium] Turn labeled GitHub issues into change requests
- #5 [evaluator, medium] Sprint mode and routines fix not verified
- #4 [evaluator, medium] App deploy enabled but no live app
- #11 [monitoring, low] Set a fixed session secret in the deploy command
- #9 [research, low] Allow an OpenAI-compatible model endpoint for agents
