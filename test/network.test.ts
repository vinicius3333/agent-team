import { test } from "node:test"
import assert from "node:assert/strict"
import { codexKeyEnvArgs } from "../src/harness/docker.ts"
import { codexEndpointHosts, proxyRules } from "../src/harness/network.ts"

test("codexEndpointHosts allows the codex base URL host and its port", () => {
  assert.deepEqual(codexEndpointHosts(null), [])
  assert.deepEqual(codexEndpointHosts({ baseUrl: "https://openrouter.ai/api/v1" }), ["openrouter.ai"])
  const hosts = codexEndpointHosts({ baseUrl: "http://gpu.tail1234.ts.net:11434/v1" })
  assert.deepEqual(hosts, ["gpu.tail1234.ts.net:11434"])
  const { filter, ports } = proxyRules(["github.com", ...hosts])
  assert.ok(ports.includes(11434))
  assert.match(filter, /\^gpu\\\.tail1234\\\.ts\\\.net\$/)
})

test("a codex run with apiKeyEnv passes the key to docker as a bare -e name", () => {
  const secret = "sk-test-secret-value-123"
  process.env.AGENT_TEAM_TEST_DOCKER_KEY = secret
  try {
    const args = codexKeyEnvArgs(["claude", "codex"], "AGENT_TEAM_TEST_DOCKER_KEY")
    assert.deepEqual(args, ["-e", "AGENT_TEAM_TEST_DOCKER_KEY"])
    assert.ok(!args.join(" ").includes(secret))
  } finally {
    delete process.env.AGENT_TEAM_TEST_DOCKER_KEY
  }
  assert.deepEqual(codexKeyEnvArgs(["codex"], null), [])
  assert.deepEqual(codexKeyEnvArgs(["claude"], "AGENT_TEAM_TEST_DOCKER_KEY"), [])
})

test("proxyRules allows ports 443 and 80 by default", () => {
  const { filter, ports } = proxyRules(["github.com", "*.npmjs.org"])
  assert.deepEqual(ports, [443, 80])
  assert.equal(filter, "^.+\\.npmjs\\.org$\n^github\\.com$\n")
})

test("proxyRules takes an extra port from a host:port entry", () => {
  const { filter, ports } = proxyRules(["box.tail1234.ts.net:4400", "github.com"])
  assert.deepEqual(ports, [443, 80, 4400])
  assert.equal(filter, "^box\\.tail1234\\.ts\\.net$\n^github\\.com$\n")
})
