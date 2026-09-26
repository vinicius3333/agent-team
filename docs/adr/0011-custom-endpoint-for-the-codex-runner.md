# 0011: An OpenAI-compatible endpoint for the Codex runner

## Context

C003 (#9) asks the Codex runner to call any OpenAI-compatible server, such as OpenRouter, vLLM, or Ollama. A key written in `pipeline.yaml` would be a committed secret.

## Decision

- `pipeline.yaml` gets `runners.codex.baseUrl` and `runners.codex.apiKeyEnv`. `apiKeyEnv` is the name of an environment variable, never the key, as with `operate.posthog.apiKeyEnv`.
- The runner passes a Codex model provider through `-c` flags: `base_url` and `env_key`. Codex reads the key from the environment by name, so the key never goes on a command line or into a log.
- The Docker sandbox copies the variable with a bare `-e <NAME>`. The egress allowlist adds the `baseUrl` host.
- `loadConfig` rejects a base URL that is not `http` or `https`, so a bad value stops the run before any agent starts.
- Only the Codex runner gets this. The Claude runner does not change.

## Consequences

- Operators can run Codex roles on cheaper or local models.
- Features the endpoint lacks (image generation, some tool calls) fail at run time; roles that need images should stay on OpenAI.
- A local server on `localhost` is not reachable from the Docker sandbox; use a host name the container can reach.
