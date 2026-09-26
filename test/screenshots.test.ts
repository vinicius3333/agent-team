import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { publicUrlEnv } from "../src/deploy.ts"
import { checkerAppEnv } from "../src/screenshots.ts"

const baseUrl = "http://agent-team-qa-demo:3000"

test("checkerAppEnv sets APP_URL and the other public URL variables to the checker's base URL", () => {
  const env = checkerAppEnv(baseUrl, null)
  assert.equal(env.APP_URL, baseUrl)
  for (const [key, value] of Object.entries(publicUrlEnv(baseUrl))) assert.equal(env[key], value, key)
  assert.equal(env.PUBLIC_URL, baseUrl)
  assert.equal(env.ORIGIN, baseUrl)
})

test("checkerAppEnv uses the alias address when the checker reaches the app by alias", () => {
  const env = checkerAppEnv("http://app:4400", null)
  assert.equal(env.APP_URL, "http://app:4400")
  assert.equal(env.NEXTAUTH_URL, "http://app:4400")
})

test("checkerAppEnv still merges in the demo access env", () => {
  const env = checkerAppEnv(baseUrl, { email: "demo@example.com", password: "a-long-demo-password" })
  assert.equal(env.APP_URL, baseUrl)
  assert.equal(env.DEMO_EMAIL, "demo@example.com")
  assert.equal(env.DEMO_PASSWORD, "a-long-demo-password")
})

test("checkerAppEnv leaves out the demo access env without an account", () => {
  const env = checkerAppEnv(baseUrl, null)
  assert.equal("DEMO_EMAIL" in env, false)
  assert.equal("DEMO_PASSWORD" in env, false)
})

// screenshot.mjs runs only inside the QA image with a browser, so check its login steps from the source.
test("the screenshot login fills the email field only when it exists and always fills the password", () => {
  const source = readFileSync(new URL("../docker/qa/screenshot.mjs", import.meta.url), "utf8")
  const signIn = source.slice(source.indexOf("async function signIn"), source.indexOf("\n}\n", source.indexOf("async function signIn")))
  assert.match(signIn, /if \(login\.email && \(await email\.count\(\)\)\) await email\.fill\(login\.email/)
  assert.match(signIn, /\n {4}await password\.fill\(login\.password/)
  assert.match(signIn, /stillOnLogin/)
})
