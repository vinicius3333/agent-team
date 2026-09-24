import assert from "node:assert/strict"
import { test } from "node:test"
import { appContainerArgs } from "../src/deploy.ts"

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

test("the app container has room for a production build during install", () => {
  const args = appContainerArgs({
    name: "app",
    dir: "/tmp/app",
    plan: { install: "npm ci && npm run build", start: "npm start", port: 3000 },
    label: "agent-team-app=1",
    restart: false,
  })
  // A Next 16 build was killed at 512m but passed in the 4g/2-CPU agent container.
  assert.equal(flag(args, "--memory"), "4g")
  assert.equal(flag(args, "--cpus"), "2")
  assert.ok(Number(flag(args, "--pids-limit")) >= 512)
  assert.equal(args.at(-1), "npm ci && npm run build && npm start")
})
