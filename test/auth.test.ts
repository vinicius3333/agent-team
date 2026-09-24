import assert from "node:assert/strict"
import type { IncomingMessage } from "node:http"
import { test } from "node:test"
import { authenticate, clientAddress, createLoginLimiter, hashPassword, loadAuthConfig, readSession, signSession, verifyPassword } from "../src/ui/auth.ts"

const secret = Buffer.alloc(32, 7)
const secretText = secret.toString("base64url")

function fakeRequest(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage
}

test("verifyPassword accepts the hashed password and rejects changes", () => {
  const stored = hashPassword("correct horse battery")
  assert.match(stored, /^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/)
  assert.equal(verifyPassword("correct horse battery", stored), true)
  assert.equal(verifyPassword("wrong horse battery", stored), false)
  const parts = stored.split("$")
  parts[4] = Buffer.alloc(16, 1).toString("base64url")
  assert.equal(verifyPassword("correct horse battery", parts.join("$")), false)
  assert.equal(verifyPassword("correct horse battery", "scrypt$nope"), false)
  assert.equal(verifyPassword("correct horse battery", ""), false)
})

test("readSession rejects a changed payload, a changed signature, and an expired session", () => {
  const cookie = signSession({ user: "dashboard", expiresAt: 2000 }, secret)
  assert.deepEqual(readSession(cookie, secret, 1000), { user: "dashboard", expiresAt: 2000 })
  const [payload, signature] = cookie.split(".")
  const forged = Buffer.from(JSON.stringify({ user: "dashboard", expiresAt: 9999 })).toString("base64url")
  assert.equal(readSession(`${forged}.${signature}`, secret, 1000), null)
  assert.equal(readSession(`${payload}.${signature.slice(0, -2)}xx`, secret, 1000), null)
  assert.equal(readSession(cookie, Buffer.alloc(32, 8), 1000), null)
  assert.equal(readSession(cookie, secret, 2000), null)
  assert.equal(readSession("garbage", secret, 1000), null)
})

test("loadAuthConfig picks the mode and rejects unsafe settings", () => {
  const hash = hashPassword("correct horse battery")
  assert.equal(loadAuthConfig({}).mode, "none")
  const password = loadAuthConfig({ AGENT_TEAM_UI_PASSWORD_HASH: hash, AGENT_TEAM_UI_SESSION_SECRET: secretText })
  assert.equal(password.mode, "password")
  assert.equal(password.generatedSecret, false)
  assert.equal(password.sessionHours, 168)
  assert.equal(loadAuthConfig({ AGENT_TEAM_UI_PASSWORD_HASH: hash }).generatedSecret, true)
  assert.equal(loadAuthConfig({ AGENT_TEAM_UI_TRUSTED_PROXIES: "10.0.0.0/8", AGENT_TEAM_UI_PROXY_USER_HEADER: "Remote-User" }).mode, "proxy")
  assert.equal(loadAuthConfig({ AGENT_TEAM_UI_PASSWORD_HASH: hash, AGENT_TEAM_UI_TRUSTED_PROXIES: "10.0.0.1", AGENT_TEAM_UI_PROXY_USER_HEADER: "Remote-User" }).mode, "password+proxy")
  assert.throws(() => loadAuthConfig({ AGENT_TEAM_UI_PASSWORD_HASH: hash, AGENT_TEAM_UI_SESSION_SECRET: "c2hvcnQ" }), /at least 32 bytes/)
  assert.throws(() => loadAuthConfig({ AGENT_TEAM_UI_PROXY_USER_HEADER: "Remote-User" }), /needs AGENT_TEAM_UI_TRUSTED_PROXIES/)
  assert.throws(() => loadAuthConfig({ AGENT_TEAM_UI_PASSWORD_HASH: "plain-password" }), /not a valid hash/)
  assert.throws(() => loadAuthConfig({ AGENT_TEAM_UI_TRUSTED_PROXIES: "not-an-ip", AGENT_TEAM_UI_PROXY_USER_HEADER: "Remote-User" }), /not an IP or CIDR/)
  assert.throws(() => loadAuthConfig({ AGENT_TEAM_UI_PASSWORD_HASH: hash, AGENT_TEAM_UI_SESSION_HOURS: "0" }), /positive number/)
})

test("authenticate trusts the proxy header only from a trusted address", () => {
  const config = loadAuthConfig({ AGENT_TEAM_UI_TRUSTED_PROXIES: "172.17.0.0/16", AGENT_TEAM_UI_PROXY_USER_HEADER: "Remote-User" })
  assert.deepEqual(authenticate(fakeRequest("::ffff:172.17.0.2", { "remote-user": "ana" }), config, 0), { user: "ana", source: "proxy" })
  assert.equal(authenticate(fakeRequest("203.0.113.9", { "remote-user": "ana" }), config, 0), null)
  assert.equal(authenticate(fakeRequest("172.17.0.2"), config, 0), null)
  assert.equal(clientAddress(fakeRequest("172.17.0.2", { "x-forwarded-for": "198.51.100.4, 172.17.0.2" }), config), "198.51.100.4")
  assert.equal(clientAddress(fakeRequest("203.0.113.9", { "x-forwarded-for": "198.51.100.4" }), config), "203.0.113.9")
})

test("the login limiter locks an address after five failures and all logins after thirty", () => {
  const limiter = createLoginLimiter()
  const minute = 60_000
  for (let attempt = 0; attempt < 4; attempt++) assert.equal(limiter.recordFailure("a", 0), "none")
  assert.equal(limiter.retryAfterMs("a", 0), 0)
  assert.equal(limiter.recordFailure("a", 0), "address")
  assert.equal(limiter.retryAfterMs("a", minute), 14 * minute)
  assert.equal(limiter.retryAfterMs("b", minute), 0)
  assert.equal(limiter.retryAfterMs("a", 15 * minute), 0)

  limiter.recordFailure("c", 0)
  limiter.recordSuccess("c")
  for (let attempt = 0; attempt < 4; attempt++) assert.equal(limiter.recordFailure("c", 0), "none")

  const spread = createLoginLimiter()
  for (let address = 0; address < 29; address++) assert.equal(spread.recordFailure(`host-${address}`, 0), "none")
  assert.equal(spread.recordFailure("host-29", 0), "global")
  assert.ok(spread.retryAfterMs("fresh", minute) > 0)
})
