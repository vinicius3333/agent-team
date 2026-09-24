import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { notificationKinds, type NotificationKind } from "./events.ts"

export const channelTypes = ["webhook", "slack", "ntfy", "email"] as const
export type ChannelType = (typeof channelTypes)[number]

interface ChannelBase {
  name: string
  events: NotificationKind[]
  // null = all projects.
  projects: string[] | null
}

export interface WebhookChannel extends ChannelBase {
  type: "webhook"
  url: string
  headers: Record<string, string>
  secret: string | null
}

export interface SlackChannel extends ChannelBase {
  type: "slack"
  url: string
}

export interface NtfyChannel extends ChannelBase {
  type: "ntfy"
  server: string
  topic: string
  token: string | null
}

export interface SmtpSettings {
  host: string
  port: number
  user: string | null
  password: string | null
}

export interface EmailChannel extends ChannelBase {
  type: "email"
  smtp: SmtpSettings
  from: string
  to: string[]
}

export type Channel = WebhookChannel | SlackChannel | NtfyChannel | EmailChannel

// A channel that names an environment variable the process does not have. It stays listed so the settings page can say why it is off.
export interface UnavailableChannel {
  name: string
  type: ChannelType
  reason: string
}

export interface NotificationConfig {
  dashboardUrl: string | null
  cooldowns: boolean
  throttle: { perProjectPerMinute: number; digestAfter: number }
  channels: Channel[]
  unavailable: UnavailableChannel[]
  // Changes when the file changes, so a channel disabled after failures comes back once the config is edited.
  version: string
}

export const notificationConfigFile = "notifications.yaml"

// "stopped" is left out of the default: a deploy or service restart stops every run and would send noise.
export const defaultEvents: NotificationKind[] = notificationKinds.filter((kind) => kind !== "stopped")

const variablePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

// Returns null when the file is missing: notifications are off.
export function loadNotificationConfig(runsDir: string, env: NodeJS.ProcessEnv = process.env): NotificationConfig | null {
  const path = join(runsDir, notificationConfigFile)
  if (!existsSync(path)) return null
  const text = readFileSync(path, "utf8")
  const raw = parse(text) ?? {}
  const errors: string[] = []
  const config: NotificationConfig = {
    dashboardUrl: raw.dashboardUrl ? String(raw.dashboardUrl).replace(/\/+$/, "") : null,
    cooldowns: raw.cooldowns ?? false,
    throttle: { perProjectPerMinute: raw.throttle?.perProjectPerMinute ?? 6, digestAfter: raw.throttle?.digestAfter ?? 3 },
    channels: [],
    unavailable: [],
    version: createHash("sha256").update(text).digest("hex").slice(0, 12),
  }
  if (config.dashboardUrl && !/^https?:\/\//.test(config.dashboardUrl)) errors.push("dashboardUrl must start with http:// or https://")
  if (typeof config.cooldowns !== "boolean") errors.push("cooldowns must be true or false")
  if (!(Number.isInteger(config.throttle.perProjectPerMinute) && config.throttle.perProjectPerMinute > 0)) errors.push("throttle.perProjectPerMinute must be a whole number above 0")
  if (!(Number.isInteger(config.throttle.digestAfter) && config.throttle.digestAfter > 0)) errors.push("throttle.digestAfter must be a whole number above 0")
  if (raw.channels !== undefined && !Array.isArray(raw.channels)) errors.push("channels must be a list")

  const names = new Set<string>()
  for (const [index, entry] of (Array.isArray(raw.channels) ? raw.channels : []).entries()) {
    const label = typeof entry?.name === "string" && entry.name ? `channel "${entry.name}"` : `channel ${index + 1}`
    const channelErrors: string[] = []
    const fail = (message: string) => channelErrors.push(`${label}: ${message}`)
    if (!entry || typeof entry !== "object") {
      errors.push(`${label}: must be a mapping`)
      continue
    }
    if (typeof entry.name !== "string" || !entry.name) fail("name is required")
    else if (names.has(entry.name)) fail("name is used twice")
    else names.add(entry.name)
    if (!channelTypes.includes(entry.type)) fail(`type must be one of ${channelTypes.join(", ")}`)
    const events = entry.events ?? defaultEvents
    if (!Array.isArray(events) || events.some((kind: unknown) => !(notificationKinds as readonly unknown[]).includes(kind))) fail(`events must be a list of ${notificationKinds.join(", ")}`)
    const projects = entry.projects ?? null
    if (projects !== null && (!Array.isArray(projects) || projects.some((project: unknown) => typeof project !== "string"))) fail("projects must be a list of project names")

    const missing = new Set<string>()
    const expanded = expandVariables(entry, env, missing)
    const required = (field: string, value: unknown) => {
      if (typeof value !== "string" || !value) fail(`${field} is required`)
    }
    const base = { name: entry.name, events, projects }
    let channel: Channel | null = null
    if (entry.type === "webhook") {
      required("url", expanded.url)
      if (expanded.headers !== undefined && (typeof expanded.headers !== "object" || Array.isArray(expanded.headers))) fail("headers must be a mapping")
      channel = { ...base, type: "webhook", url: expanded.url, headers: Object.fromEntries(Object.entries(expanded.headers ?? {}).map(([key, value]) => [key, String(value)])), secret: expanded.secret || null }
    } else if (entry.type === "slack") {
      required("url", expanded.url)
      channel = { ...base, type: "slack", url: expanded.url }
    } else if (entry.type === "ntfy") {
      required("topic", expanded.topic)
      channel = { ...base, type: "ntfy", server: String(expanded.server ?? "https://ntfy.sh").replace(/\/+$/, ""), topic: expanded.topic, token: expanded.token || null }
    } else if (entry.type === "email") {
      required("smtp.host", expanded.smtp?.host)
      required("from", expanded.from)
      const to = typeof expanded.to === "string" ? [expanded.to] : expanded.to
      if (!Array.isArray(to) || !to.length) fail("to must list at least one address")
      const port = Number(expanded.smtp?.port ?? 587)
      if (!Number.isInteger(port)) fail("smtp.port must be a whole number")
      channel = { ...base, type: "email", smtp: { host: expanded.smtp?.host, port, user: expanded.smtp?.user || null, password: expanded.smtp?.password || null }, from: expanded.from, to: to ?? [] }
    }
    for (const field of ["url", "server"] as const) {
      const value = expanded[field]
      if (typeof value === "string" && value && !missing.size && !/^https?:\/\//.test(value)) fail(`${field} must start with http:// or https://`)
    }
    if (missing.size) {
      config.unavailable.push({ name: entry.name, type: entry.type, reason: `missing environment variable ${[...missing].join(", ")}` })
      continue
    }
    if (channelErrors.length) errors.push(...channelErrors)
    else if (channel) config.channels.push(channel)
  }
  if (errors.length) throw new Error(`Invalid ${path}:\n- ${errors.join("\n- ")}`)
  return config
}

// Replaces ${NAME} in every string with the environment value; names that are not set go into missing.
function expandVariables(value: any, env: NodeJS.ProcessEnv, missing: Set<string>): any {
  if (typeof value === "string") {
    return value.replace(variablePattern, (_, name: string) => {
      const found = env[name]
      if (found === undefined || found === "") missing.add(name)
      return found ?? ""
    })
  }
  if (Array.isArray(value)) return value.map((item) => expandVariables(item, env, missing))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandVariables(item, env, missing)]))
  return value
}

// Every value that must not show up in logs, errors, or the dashboard.
export function channelSecrets(channel: Channel): string[] {
  const values = (() => {
    switch (channel.type) {
      case "webhook":
        return [channel.url, channel.secret, ...Object.values(channel.headers), new URL(channel.url).search.slice(1), ...new URL(channel.url).searchParams.values()]
      case "slack":
        return [channel.url, new URL(channel.url).pathname]
      case "ntfy":
        return [channel.topic, channel.token]
      case "email":
        return [channel.smtp.password, channel.smtp.user]
    }
  })()
  return values.filter((value): value is string => typeof value === "string" && value.length >= 4).sort((a, b) => b.length - a.length)
}

export function maskSecrets(text: string, channel: Channel): string {
  return channelSecrets(channel).reduce((masked, secret) => masked.split(secret).join("***"), text)
}

// What the dashboard may show about where a channel sends: the host only, never a path, topic, or token.
export function maskedTarget(channel: Channel): string {
  switch (channel.type) {
    case "webhook":
      return `${new URL(channel.url).host}/***`
    case "slack":
      return `${new URL(channel.url).host}/***`
    case "ntfy":
      return `${new URL(channel.server).host}/***`
    case "email":
      return `${channel.smtp.host} to ${channel.to.length} address${channel.to.length === 1 ? "" : "es"}`
  }
}
