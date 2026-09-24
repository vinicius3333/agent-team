import { randomBytes } from "node:crypto"
import type { Store } from "./store.ts"

export interface DemoAccess {
  email: string
  password: string
}

const accessKey = "demo.access"
// example.com is reserved (RFC 2606), so the seeded account can never belong to a real person.
const demoEmail = "demo@example.com"

// Made once per project and kept in the state DB, never in git: the app reads it from DEMO_EMAIL and DEMO_PASSWORD.
export function ensureDemoAccess(store: Store): DemoAccess {
  const existing = readDemoAccess(store.meta(accessKey))
  if (existing) return existing
  const access = { email: demoEmail, password: randomBytes(18).toString("base64url") }
  store.setMeta(accessKey, JSON.stringify(access))
  return access
}

export function readDemoAccess(value: string | null | undefined): DemoAccess | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return typeof parsed?.email === "string" && typeof parsed?.password === "string" ? { email: parsed.email, password: parsed.password } : null
  } catch {
    return null
  }
}

export function demoAccessEnv(access: DemoAccess | null): Record<string, string> {
  return access ? { DEMO_EMAIL: access.email, DEMO_PASSWORD: access.password } : {}
}

export const demoAccessMetaKey = accessKey
