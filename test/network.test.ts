import { test } from "node:test"
import assert from "node:assert/strict"
import { proxyRules } from "../src/harness/network.ts"

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
