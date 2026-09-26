import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parse } from "yaml"

const workflowPath = new URL("../.github/workflows/release-image.yml", import.meta.url)
const text = readFileSync(workflowPath, "utf8")
const workflow = parse(text) as {
  on: { release: { types: string[] } }
  permissions: Record<string, string>
  jobs: Record<string, { steps: { uses?: string; run?: string; with?: Record<string, unknown> }[] }>
}
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps)
const step = (action: string) => steps.find((item) => item.uses === action)

test("the workflow runs when a release is published", () => {
  assert.ok(workflow.on.release.types.includes("published"))
  assert.deepEqual(Object.keys(workflow.on), ["release"])
})

test("the workflow can read the repo and write packages only", () => {
  assert.deepEqual(workflow.permissions, { contents: "read", packages: "write" })
})

test("the workflow names the ghcr.io image with the release tag and latest", () => {
  assert.ok(text.includes("ghcr.io/vinicius3333/agent-team"))
  const meta = step("docker/metadata-action@v5")
  assert.ok(meta)
  assert.equal(meta.with?.images, "ghcr.io/vinicius3333/agent-team")
  const tags = String(meta.with?.tags).split("\n").map((line) => line.trim()).filter(Boolean)
  assert.deepEqual(tags, ["type=raw,value=${{ github.event.release.tag_name }}", "type=raw,value=latest"])
})

test("the workflow logs in to ghcr.io with the built-in token only", () => {
  const login = step("docker/login-action@v3")
  assert.ok(login)
  assert.equal(login.with?.registry, "ghcr.io")
  assert.equal(login.with?.username, "${{ github.actor }}")
  assert.equal(login.with?.password, "${{ secrets.GITHUB_TOKEN }}")
  const secrets = text.match(/secrets\.[A-Za-z_]+/g) ?? []
  assert.deepEqual([...new Set(secrets)], ["secrets.GITHUB_TOKEN"])
})

test("the build step pushes the Dockerfile for amd64 and arm64", () => {
  const build = step("docker/build-push-action@v6")
  assert.ok(build)
  assert.equal(build.with?.context, ".")
  assert.equal(build.with?.file, "Dockerfile")
  assert.equal(build.with?.push, true)
  assert.equal(build.with?.platforms, "linux/amd64,linux/arm64")
})

test("the workflow uses the pinned actions and runs no tests", () => {
  const actions = steps.map((item) => item.uses).filter(Boolean)
  for (const action of ["actions/checkout@v4", "docker/setup-qemu-action@v3", "docker/setup-buildx-action@v3"]) {
    assert.ok(actions.includes(action), `missing ${action}`)
  }
  assert.equal(steps.filter((item) => item.run).length, 0)
})
