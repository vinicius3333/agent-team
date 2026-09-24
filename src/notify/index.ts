import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fingerprint } from "../incidents.ts"
import type { RunStop } from "../pipeline.ts"
import { listProjects, openProjectStore, processAlive } from "../project.ts"
import type { Store } from "../store.ts"
import { defaultChannelDeps, send, type ChannelDeps } from "./channels.ts"
import { loadNotificationConfig, maskedTarget, maskSecrets, type Channel, type ChannelType, type NotificationConfig } from "./config.ts"
import { interruptPrefix, notificationFor, type NotificationKind } from "./events.ts"
import { buildDigest, buildMessage, buildTestMessage, type Message } from "./message.ts"

export interface NotifyDeps extends ChannelDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
  retryDelaysMs: number[]
  log: (line: string) => void
  env: NodeJS.ProcessEnv
  // Identifies the sender in the lock file; tests pass a fake one to act as a second process.
  pid: number
}

export const defaultNotifyDeps: NotifyDeps = {
  ...defaultChannelDeps,
  now: Date.now,
  sleep: (ms) => sleep(ms),
  retryDelaysMs: [5_000, 30_000],
  log: (line) => console.log(line),
  env: process.env,
  pid: process.pid,
}

export const cursorKey = "notify.cursor"
export const sentKey = "notify.sent"
const interruptedKey = "notify.interrupted"
export const lockFile = ".notify.lock"
export const stateFile = ".notify-state.json"
export const loopIntervalMs = 15_000
const staleMs = 24 * 60 * 60_000
const dedupMs = 6 * 60 * 60_000
const throttleWindowMs = 60_000
export const failureLimit = 5
const eventBatchLimit = 500

export interface ChannelState {
  lastSuccessAt: string | null
  lastError: { at: string; status: number | null; message: string } | null
  consecutiveFailures: number
  disabled: boolean
  // pid and config version the failure count belongs to; a restart or a config edit starts the count again.
  owner: string
}

type DeliveryState = Record<string, ChannelState>

// Sends per project in the last minute, kept in memory: a restart may send a few extra.
const recentSends = new Map<string, number[]>()
const loggedOnce = new Set<string>()

function logOnce(deps: NotifyDeps, line: string): void {
  if (loggedOnce.has(line)) return
  loggedOnce.add(line)
  deps.log(line)
}

export function acquireLock(runsDir: string, pid: number): boolean {
  const path = join(runsDir, lockFile)
  if (existsSync(path)) {
    const holder = Number(readFileSync(path, "utf8"))
    if (holder && holder !== pid && processAlive(holder)) return false
  }
  writeFileSync(path, String(pid))
  return true
}

export function releaseLock(runsDir: string, pid: number): void {
  const path = join(runsDir, lockFile)
  if (existsSync(path) && Number(readFileSync(path, "utf8")) === pid) rmSync(path, { force: true })
}

export function readDeliveryState(runsDir: string): DeliveryState {
  const path = join(runsDir, stateFile)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeliveryState
  } catch {
    return {}
  }
}

function writeDeliveryState(runsDir: string, state: DeliveryState): void {
  const path = join(runsDir, stateFile)
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

function channelState(state: DeliveryState, name: string, owner: string): ChannelState {
  const current = state[name]
  if (current && current.owner === owner) return current
  state[name] = { lastSuccessAt: current?.lastSuccessAt ?? null, lastError: current?.lastError ?? null, consecutiveFailures: 0, disabled: false, owner }
  return state[name]
}

function readStop(store: Store): RunStop | null {
  try {
    return JSON.parse(store.meta("run.stop") || "null") as RunStop | null
  } catch {
    return null
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dedupReason(kind: NotificationKind, reason: string, eventId: number): string {
  // Each "ready for review" is a new review round (for example after requested changes), so it is never a duplicate.
  return kind === "gate" ? `${reason} #${eventId}` : reason
}

// Reads the project's new events, moves its cursor, and returns the messages due now.
function collectProject(runsDir: string, project: string, config: NotificationConfig, deps: NotifyDeps): Message[] {
  const store = openProjectStore(join(runsDir, project))
  try {
    const cursor = store.meta(cursorKey)
    if (cursor === null) {
      store.setMeta(cursorKey, String(store.lastEventId()))
      return []
    }
    const events = store.eventsAfter(Number(cursor), eventBatchLimit)
    if (!events.length) return []
    const now = deps.now()
    const stop = readStop(store)
    const sent = Object.fromEntries(Object.entries(JSON.parse(store.meta(sentKey) || "{}") as Record<string, number>).filter(([, at]) => now - at < dedupMs))
    const context = { dashboardUrl: config.dashboardUrl, costUsd: Math.round(store.projectCost().usd * 100) / 100 }
    let interrupted = store.meta(interruptedKey) === "1"
    let stale = 0
    const due: Message[] = []
    for (const event of events) {
      const notification = notificationFor(event, stop, { cooldowns: config.cooldowns, interrupted })
      if (event.type === "run" && event.message.startsWith(interruptPrefix)) interrupted = true
      if (event.type === "run" && event.message.startsWith("finished:")) interrupted = false
      if (!notification) continue
      if (now - Date.parse(event.at) > staleMs) {
        stale++
        continue
      }
      const key = `${project}:${notification.kind}:${fingerprint(notification.kind, dedupReason(notification.kind, notification.reason, event.id))}`
      if (sent[key]) continue
      sent[key] = now
      due.push(buildMessage(project, notification, event, context))
    }
    store.setMeta(cursorKey, String(events.at(-1)!.id))
    store.setMeta(interruptedKey, interrupted ? "1" : "")
    store.setMeta(sentKey, JSON.stringify(sent))
    if (stale) deps.log(`[notify] ${project}: skipped ${stale} notification${stale === 1 ? "" : "s"} older than 24 h (the notifier was not running)`)
    return throttle(runsDir, project, due, config, deps)
  } finally {
    store.close()
  }
}

// Action messages always go out; info messages share perProjectPerMinute.
function throttle(runsDir: string, project: string, messages: Message[], config: NotificationConfig, deps: NotifyDeps): Message[] {
  const key = `${resolve(runsDir)}:${project}`
  const now = deps.now()
  const recent = (recentSends.get(key) ?? []).filter((at) => now - at < throttleWindowMs)
  const allowed: Message[] = []
  let dropped = 0
  for (const message of messages) {
    if (message.severity === "action") allowed.push(message)
    else if (recent.length < config.throttle.perProjectPerMinute) {
      recent.push(now)
      allowed.push(message)
    } else dropped++
  }
  recentSends.set(key, recent)
  if (dropped) deps.log(`[notify] ${project}: dropped ${dropped} info notification${dropped === 1 ? "" : "s"} over the limit of ${config.throttle.perProjectPerMinute} per minute`)
  return allowed
}

function accepts(channel: Channel, message: Message): boolean {
  return (channel.events as string[]).includes(message.kind) && (channel.projects === null || channel.projects.includes(message.project))
}

// More than digestAfter messages for one project in one pass become one digest.
function batchFor(channel: Channel, messages: Message[], config: NotificationConfig, now: Date): Message[] {
  const byProject = new Map<string, Message[]>()
  for (const message of messages.filter((message) => accepts(channel, message))) byProject.set(message.project, [...(byProject.get(message.project) ?? []), message])
  return [...byProject.entries()].flatMap(([project, list]) => (list.length > config.throttle.digestAfter ? [buildDigest(project, list, { dashboardUrl: config.dashboardUrl, costUsd: list.at(-1)!.costUsd }, now)] : list))
}

async function sendWithRetries(channel: Channel, message: Message, deps: NotifyDeps, retryDelaysMs: number[]): Promise<void> {
  let lastError: unknown
  for (const delay of [0, ...retryDelaysMs]) {
    if (delay) await deps.sleep(delay)
    try {
      return await send(channel, message, deps)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function recordSuccess(entry: ChannelState, deps: NotifyDeps): void {
  entry.lastSuccessAt = new Date(deps.now()).toISOString()
  entry.consecutiveFailures = 0
  entry.disabled = false
}

function recordFailure(entry: ChannelState, channel: Channel, error: unknown, deps: NotifyDeps): string {
  const message = maskSecrets(errorText(error), channel).slice(0, 200)
  const status = /^HTTP (\d{3})/.exec(message)?.[1]
  entry.lastError = { at: new Date(deps.now()).toISOString(), status: status ? Number(status) : null, message }
  entry.consecutiveFailures++
  deps.log(`[notify] channel "${channel.name}" failed: ${message}`)
  if (entry.consecutiveFailures >= failureLimit && !entry.disabled) {
    entry.disabled = true
    deps.log(`[notify] channel "${channel.name}" is off after ${failureLimit} failures in a row; restart the service or edit notifications.yaml to turn it back on`)
  }
  return message
}

async function deliver(channel: Channel, messages: Message[], entry: ChannelState, deps: NotifyDeps): Promise<void> {
  for (const message of messages) {
    if (entry.disabled) return
    try {
      await sendWithRetries(channel, message, deps, deps.retryDelaysMs)
      recordSuccess(entry, deps)
    } catch (error) {
      recordFailure(entry, channel, error, deps)
    }
  }
}

function loadConfigOrLog(runsDir: string, deps: NotifyDeps): NotificationConfig | null {
  try {
    const config = loadNotificationConfig(runsDir, deps.env)
    for (const channel of config?.unavailable ?? []) logOnce(deps, `[notify] channel "${channel.name}" is off: ${channel.reason}`)
    return config
  } catch (error) {
    logOnce(deps, `[notify] notifications are off: ${errorText(error)}`)
    return null
  }
}

// One pass: read new events in every project, send what is due, and record how each channel did.
export async function checkNotifications(runsDir: string, overrides: Partial<NotifyDeps> = {}): Promise<void> {
  const deps: NotifyDeps = { ...defaultNotifyDeps, ...overrides }
  const config = loadConfigOrLog(runsDir, deps)
  if (!config || !acquireLock(runsDir, deps.pid)) return
  const messages: Message[] = []
  for (const project of listProjects(runsDir)) {
    try {
      messages.push(...collectProject(runsDir, project, config, deps))
    } catch (error) {
      deps.log(`[notify] ${project}: ${errorText(error)}`)
    }
  }
  if (!messages.length) return
  const state = readDeliveryState(runsDir)
  const owner = `${deps.pid}:${config.version}`
  const now = new Date(deps.now())
  // Channels send side by side, so a slow or dead one does not hold up the others.
  await Promise.all(config.channels.map((channel) => deliver(channel, batchFor(channel, messages, config, now), channelState(state, channel.name, owner), deps)))
  writeDeliveryState(runsDir, state)
}

export interface TestResult {
  channel: string
  ok: boolean
  error: string | null
}

export class UnknownChannelError extends Error {}

// Sends one test message per channel, once, without retries, so the answer comes back fast.
export async function sendTest(runsDir: string, channelName: string | null, overrides: Partial<NotifyDeps> = {}): Promise<TestResult[]> {
  const deps: NotifyDeps = { ...defaultNotifyDeps, ...overrides }
  const config = loadNotificationConfig(runsDir, deps.env)
  if (!config) throw new UnknownChannelError(`${join(runsDir, "notifications.yaml")} does not exist, so no channel is set up`)
  const channels = config.channels.filter((channel) => !channelName || channel.name === channelName)
  const unavailable = config.unavailable.filter((channel) => !channelName || channel.name === channelName)
  if (channelName && !channels.length && !unavailable.length) throw new UnknownChannelError(`no channel named "${channelName}"`)
  const state = readDeliveryState(runsDir)
  const owner = `${deps.pid}:${config.version}`
  const message = buildTestMessage(config.dashboardUrl, new Date(deps.now()))
  const results = await Promise.all(
    channels.map(async (channel): Promise<TestResult> => {
      const entry = channelState(state, channel.name, owner)
      try {
        await send(channel, message, deps)
        recordSuccess(entry, deps)
        return { channel: channel.name, ok: true, error: null }
      } catch (error) {
        return { channel: channel.name, ok: false, error: recordFailure(entry, channel, error, deps) }
      }
    }),
  )
  writeDeliveryState(runsDir, state)
  return [...results, ...unavailable.map((channel) => ({ channel: channel.name, ok: false, error: channel.reason }))]
}

export interface ChannelStatus {
  name: string
  type: ChannelType
  target: string | null
  events: NotificationKind[]
  projects: string[] | null
  enabled: boolean
  offReason: string | null
  lastSuccessAt: string | null
  lastError: ChannelState["lastError"]
}

export interface NotificationStatus {
  configured: boolean
  error: string | null
  channels: ChannelStatus[]
}

// What the settings page shows. Never a URL path, topic, token, or password.
export function notificationStatus(runsDir: string, env: NodeJS.ProcessEnv = process.env): NotificationStatus {
  let config: NotificationConfig | null
  try {
    config = loadNotificationConfig(runsDir, env)
  } catch (error) {
    return { configured: true, error: errorText(error), channels: [] }
  }
  if (!config) return { configured: false, error: null, channels: [] }
  const state = readDeliveryState(runsDir)
  const available = config.channels.map((channel): ChannelStatus => {
    const entry = state[channel.name]
    const [ownerPid, ownerVersion] = (entry?.owner ?? "").split(":")
    const disabled = Boolean(entry?.disabled) && ownerVersion === config.version && processAlive(Number(ownerPid))
    return {
      name: channel.name,
      type: channel.type,
      target: maskedTarget(channel),
      events: channel.events,
      projects: channel.projects,
      enabled: !disabled,
      offReason: disabled ? `off after ${failureLimit} failures in a row` : null,
      lastSuccessAt: entry?.lastSuccessAt ?? null,
      lastError: entry?.lastError ?? null,
    }
  })
  const unavailable = config.unavailable.map((channel): ChannelStatus => ({
    name: channel.name,
    type: channel.type,
    target: null,
    events: [],
    projects: null,
    enabled: false,
    offReason: channel.reason,
    lastSuccessAt: state[channel.name]?.lastSuccessAt ?? null,
    lastError: state[channel.name]?.lastError ?? null,
  }))
  return { configured: true, error: null, channels: [...available, ...unavailable] }
}

// Runs a pass every 15 s until stopped. The timer does not keep the process alive on its own.
export function startNotificationLoop(runsDir: string, options: { signal?: AbortSignal; intervalMs?: number; deps?: Partial<NotifyDeps> } = {}): () => void {
  const intervalMs = options.intervalMs ?? loopIntervalMs
  const pid = options.deps?.pid ?? process.pid
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const schedule = (delay: number) => {
    if (stopped) return
    timer = setTimeout(tick, delay)
    timer.unref()
  }
  const tick = async () => {
    try {
      await checkNotifications(runsDir, options.deps)
    } catch (error) {
      console.error(`[notify] ${errorText(error)}`)
    }
    schedule(intervalMs)
  }
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    releaseLock(runsDir, pid)
  }
  options.signal?.addEventListener("abort", stop, { once: true })
  schedule(0)
  return stop
}
