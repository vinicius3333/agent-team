import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { BlockList, isIPv4, isIPv6 } from "node:net"

export type AuthMode = "none" | "password" | "proxy" | "password+proxy"

export interface AuthConfig {
  mode: AuthMode
  passwordHash?: string
  sessionSecret?: Buffer
  generatedSecret?: boolean
  sessionHours?: number
  trustedProxies?: string[]
  proxyUserHeader?: string
}

export interface AuthenticatedUser {
  user: string
  source: "proxy" | "session"
}

export interface Session {
  user: string
  expiresAt: number
}

export const sessionCookieName = "agent_team_session"
export const passwordUser = "dashboard"
export const passwordMinLength = 12
const defaultSessionHours = 168
const secretMinBytes = 32
const scryptParameters = { N: 2 ** 15, r: 8, p: 1 }
const saltBytes = 16
const hashBytes = 32
const hashPattern = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, length: number): Buffer {
  return scryptSync(password, salt, length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 })
}

export function hashPassword(password: string): string {
  const { N, r, p } = scryptParameters
  const salt = randomBytes(saltBytes)
  const hash = scrypt(password, salt, N, r, p, hashBytes)
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`
}

function parseHash(stored: string) {
  const match = hashPattern.exec(stored)
  if (!match) return null
  const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const salt = Buffer.from(match[4], "base64url")
  const hash = Buffer.from(match[5], "base64url")
  const powerOfTwo = N > 1 && (N & (N - 1)) === 0
  if (!powerOfTwo || r < 1 || p < 1 || salt.length < saltBytes || hash.length < 16) return null
  return { N, r, p, salt, hash }
}

export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseHash(stored)
  if (!parsed) return false
  try {
    const candidate = scrypt(password, parsed.salt, parsed.N, parsed.r, parsed.p, parsed.hash.length)
    return timingSafeEqual(candidate, parsed.hash)
  } catch {
    return false
  }
}

export function generateSessionSecret(): string {
  return randomBytes(secretMinBytes).toString("base64url")
}

function trustedProxyList(entries: string[]): BlockList {
  const list = new BlockList()
  for (const entry of entries) {
    const [address, prefix] = entry.split("/")
    const type = isIPv4(address) ? "ipv4" : isIPv6(address) ? "ipv6" : null
    const bits = prefix === undefined ? null : Number(prefix)
    const maxBits = type === "ipv4" ? 32 : 128
    if (!type || (bits !== null && (!Number.isInteger(bits) || bits < 0 || bits > maxBits))) {
      throw new Error(`AGENT_TEAM_UI_TRUSTED_PROXIES has an entry that is not an IP or CIDR: "${entry}".`)
    }
    if (bits === null) list.addAddress(address, type)
    else list.addSubnet(address, bits, type)
  }
  return list
}

export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const passwordHash = env.AGENT_TEAM_UI_PASSWORD_HASH?.trim() || undefined
  if (passwordHash && !parseHash(passwordHash)) {
    throw new Error("AGENT_TEAM_UI_PASSWORD_HASH is not a valid hash. Make one with: agent-team hash-password")
  }
  const trustedProxies = (env.AGENT_TEAM_UI_TRUSTED_PROXIES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
  trustedProxyList(trustedProxies)
  const proxyUserHeader = env.AGENT_TEAM_UI_PROXY_USER_HEADER?.trim().toLowerCase() || undefined
  if (proxyUserHeader && !trustedProxies.length) {
    throw new Error("AGENT_TEAM_UI_PROXY_USER_HEADER needs AGENT_TEAM_UI_TRUSTED_PROXIES, or any client could send the header.")
  }
  if (trustedProxies.length && !proxyUserHeader && !passwordHash) {
    throw new Error("AGENT_TEAM_UI_TRUSTED_PROXIES needs AGENT_TEAM_UI_PROXY_USER_HEADER or AGENT_TEAM_UI_PASSWORD_HASH.")
  }
  const rawSecret = env.AGENT_TEAM_UI_SESSION_SECRET?.trim()
  const sessionSecret = rawSecret ? Buffer.from(rawSecret, "base64url") : randomBytes(secretMinBytes)
  if (sessionSecret.length < secretMinBytes) {
    throw new Error(`AGENT_TEAM_UI_SESSION_SECRET must be at least ${secretMinBytes} bytes of base64url. Make one with: agent-team session-secret`)
  }
  const sessionHours = env.AGENT_TEAM_UI_SESSION_HOURS ? Number(env.AGENT_TEAM_UI_SESSION_HOURS) : defaultSessionHours
  if (!Number.isFinite(sessionHours) || sessionHours <= 0) throw new Error("AGENT_TEAM_UI_SESSION_HOURS must be a positive number.")
  const mode: AuthMode = passwordHash && proxyUserHeader ? "password+proxy" : passwordHash ? "password" : proxyUserHeader ? "proxy" : "none"
  return { mode, passwordHash, sessionSecret, generatedSecret: !rawSecret, sessionHours, trustedProxies, proxyUserHeader }
}

function signature(payload: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}

export function signSession(session: Session, secret: Buffer): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url")
  return `${payload}.${signature(payload, secret)}`
}

export function readSession(cookie: string, secret: Buffer, now: number): Session | null {
  const [payload, signed, ...rest] = cookie.split(".")
  if (!payload || !signed || rest.length) return null
  const expected = Buffer.from(signature(payload, secret))
  const actual = Buffer.from(signed)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (typeof session?.user !== "string" || typeof session?.expiresAt !== "number") return null
    return session.expiresAt > now ? { user: session.user, expiresAt: session.expiresAt } : null
  } catch {
    return null
  }
}

export function readCookie(request: IncomingMessage, name: string): string | null {
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=")
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return null
}

function plainAddress(address: string): string {
  return address.startsWith("::ffff:") && isIPv4(address.slice(7)) ? address.slice(7) : address
}

const proxyListCache = new WeakMap<AuthConfig, BlockList>()

export function fromTrustedProxy(request: IncomingMessage, config: AuthConfig): boolean {
  if (!config.trustedProxies?.length) return false
  const address = plainAddress(request.socket.remoteAddress ?? "")
  const type = isIPv4(address) ? "ipv4" : isIPv6(address) ? "ipv6" : null
  if (!type) return false
  let list = proxyListCache.get(config)
  if (!list) {
    list = trustedProxyList(config.trustedProxies)
    proxyListCache.set(config, list)
  }
  return list.check(address, type)
}

// The forwarded address is only believed from a trusted proxy; anyone else could put any value there.
export function clientAddress(request: IncomingMessage, config: AuthConfig): string {
  const socketAddress = plainAddress(request.socket.remoteAddress ?? "unknown")
  if (!fromTrustedProxy(request, config)) return socketAddress
  const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",")[0].trim()
  return forwarded || socketAddress
}

export function authenticate(request: IncomingMessage, config: AuthConfig, now: number): AuthenticatedUser | null {
  if (config.proxyUserHeader && fromTrustedProxy(request, config)) {
    const user = String(request.headers[config.proxyUserHeader] ?? "").trim()
    if (user) return { user, source: "proxy" }
  }
  if (!config.passwordHash || !config.sessionSecret) return null
  const cookie = readCookie(request, sessionCookieName)
  const session = cookie ? readSession(cookie, config.sessionSecret, now) : null
  return session ? { user: session.user, source: "session" } : null
}

export interface LoginLimits {
  windowMs: number
  lockMs: number
  perAddress: number
  global: number
}

export const defaultLoginLimits: LoginLimits = { windowMs: 15 * 60_000, lockMs: 15 * 60_000, perAddress: 5, global: 30 }

export function createLoginLimiter(limits: LoginLimits = defaultLoginLimits) {
  const addresses = new Map<string, { failures: number[]; lockedUntil: number }>()
  let globalFailures: number[] = []
  let globalLockedUntil = 0

  const forget = (now: number) => {
    const since = now - limits.windowMs
    for (const [address, entry] of addresses) {
      entry.failures = entry.failures.filter((at) => at > since)
      if (!entry.failures.length && entry.lockedUntil <= now) addresses.delete(address)
    }
    globalFailures = globalFailures.filter((at) => at > since)
  }

  return {
    retryAfterMs(address: string, now: number): number {
      forget(now)
      const until = Math.max(globalLockedUntil, addresses.get(address)?.lockedUntil ?? 0)
      return Math.max(0, until - now)
    },
    recordFailure(address: string, now: number): "none" | "address" | "global" {
      forget(now)
      const entry = addresses.get(address) ?? { failures: [], lockedUntil: 0 }
      addresses.set(address, entry)
      entry.failures.push(now)
      globalFailures.push(now)
      if (globalFailures.length >= limits.global) {
        globalLockedUntil = now + limits.lockMs
        globalFailures = []
        return "global"
      }
      if (entry.failures.length >= limits.perAddress) {
        entry.lockedUntil = now + limits.lockMs
        entry.failures = []
        return "address"
      }
      return "none"
    },
    recordSuccess(address: string): void {
      addresses.delete(address)
    },
  }
}

export type LoginLimiter = ReturnType<typeof createLoginLimiter>
