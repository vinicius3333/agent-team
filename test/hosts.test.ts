import assert from "node:assert/strict"
import { test } from "node:test"
import { parseHostList, previewHosts } from "../src/ui/hosts.ts"

test("parseHostList trims, lower-cases, and drops empty values and duplicates", () => {
  assert.deepEqual(parseHostList(undefined), [])
  assert.deepEqual(parseHostList(""), [])
  assert.deepEqual(parseHostList(" a.example, ,A.example,b.example,"), ["a.example", "b.example"])
})

test("an empty environment gives no preview hosts", () => {
  assert.deepEqual(previewHosts({}), [])
})

test("AGENT_TEAM_UI_HOSTS names are trimmed, lower-cased, and kept once", () => {
  assert.deepEqual(previewHosts({ AGENT_TEAM_UI_HOSTS: " a.example, ,A.example" }), ["a.example"])
})

test("APP_URL gives its host name without the port", () => {
  assert.deepEqual(previewHosts({ APP_URL: "http://agent-team-qa-agent-team:4400" }), ["agent-team-qa-agent-team"])
})

test("HOSTNAME gives the container name when APP_URL is missing", () => {
  assert.deepEqual(previewHosts({ HOSTNAME: "agent-team-qa-agent-team" }), ["agent-team-qa-agent-team"])
})

test("bad URLs and empty or invalid HOSTNAME values are skipped", () => {
  assert.deepEqual(previewHosts({ APP_URL: "not a url", HOSTNAME: "" }), [])
  assert.deepEqual(previewHosts({ PUBLIC_URL: "", HOSTNAME: "bad host;name" }), [])
})

test("every public URL variable adds its host name", () => {
  const env = {
    APP_URL: "https://app.example",
    PUBLIC_URL: "https://public.example",
    BASE_URL: "https://base.example",
    ORIGIN: "https://origin.example",
    NEXTAUTH_URL: "https://auth.example",
    NEXT_PUBLIC_APP_URL: "https://next.example",
  }
  assert.deepEqual(previewHosts(env), ["app.example", "public.example", "base.example", "origin.example", "auth.example", "next.example"])
})

test("all sources set with overlaps give each name once, in order", () => {
  const hosts = previewHosts({
    AGENT_TEAM_UI_HOSTS: "other.example,Agent-Team-QA-Agent-Team",
    APP_URL: "http://agent-team-qa-agent-team:4400",
    PUBLIC_URL: "https://OTHER.example/path",
    ORIGIN: "https://app.example:8443",
    HOSTNAME: "Agent-Team-QA-Agent-Team",
  })
  assert.deepEqual(hosts, ["other.example", "agent-team-qa-agent-team", "app.example"])
})
