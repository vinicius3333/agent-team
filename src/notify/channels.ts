import { createHmac } from "node:crypto"
import type { Channel, EmailChannel, NtfyChannel, SlackChannel, SmtpSettings, WebhookChannel } from "./config.ts"
import type { Message } from "./message.ts"

export const signatureHeader = "X-Agent-Team-Signature"
export const sendTimeoutMs = 10_000

export interface Mail {
  from: string
  to: string[]
  subject: string
  text: string
}

export type Mailer = (smtp: SmtpSettings, mail: Mail) => Promise<void>

export interface ChannelDeps {
  fetch: typeof fetch
  mailer: Mailer
  timeoutMs: number
}

// nodemailer is optional: only a config with an email channel needs it, so it is loaded on first use.
const nodemailerMailer: Mailer = async (smtp, mail) => {
  const moduleName = "nodemailer"
  let nodemailer: any
  try {
    nodemailer = await import(moduleName)
  } catch {
    throw new Error("email channels need nodemailer: run npm install nodemailer in the agent-team folder")
  }
  const transport = (nodemailer.default ?? nodemailer).createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? "" } : undefined,
    connectionTimeout: sendTimeoutMs,
    greetingTimeout: sendTimeoutMs,
    socketTimeout: sendTimeoutMs,
  })
  await transport.sendMail({ from: mail.from, to: mail.to.join(", "), subject: mail.subject, text: mail.text })
}

export const defaultChannelDeps: ChannelDeps = { fetch: (...args) => fetch(...args), mailer: nodemailerMailer, timeoutMs: sendTimeoutMs }

export interface HttpRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export function webhookRequest(channel: WebhookChannel, message: Message): HttpRequest {
  const body = JSON.stringify(message)
  const headers: Record<string, string> = { "content-type": "application/json", ...channel.headers }
  if (channel.secret) headers[signatureHeader] = `sha256=${createHmac("sha256", channel.secret).update(body).digest("hex")}`
  return { url: channel.url, headers, body }
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function slackRequest(channel: SlackChannel, message: Message): HttpRequest {
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `*${escapeSlack(message.title)}*\n${escapeSlack(message.body)}` } }]
  if (message.url) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open dashboard" }, url: message.url }] })
  return { url: channel.url, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `${message.title}\n${message.body}`, blocks }) }
}

// fetch rejects header values outside Latin-1, and ntfy reads plain ASCII headers best.
function headerValue(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?")
}

export function ntfyRequest(channel: NtfyChannel, message: Message): HttpRequest {
  const headers: Record<string, string> = {
    Title: headerValue(message.title),
    Priority: message.severity === "action" ? "high" : "default",
    Tags: headerValue(["agent-team", message.kind].join(",")),
  }
  if (message.url) headers.Click = message.url
  if (channel.token) headers.Authorization = `Bearer ${channel.token}`
  return { url: `${channel.server}/${encodeURIComponent(channel.topic)}`, headers, body: message.body }
}

export function emailMail(channel: EmailChannel, message: Message): Mail {
  return { from: channel.from, to: channel.to, subject: message.title, text: message.url ? `${message.body}\n\n${message.url}` : message.body }
}

async function post(request: HttpRequest, deps: ChannelDeps): Promise<void> {
  const response = await deps.fetch(request.url, { method: "POST", headers: request.headers, body: request.body, signal: AbortSignal.timeout(deps.timeoutMs) })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`)
  }
}

export async function send(channel: Channel, message: Message, deps: ChannelDeps = defaultChannelDeps): Promise<void> {
  switch (channel.type) {
    case "webhook":
      return post(webhookRequest(channel, message), deps)
    case "slack":
      return post(slackRequest(channel, message), deps)
    case "ntfy":
      return post(ntfyRequest(channel, message), deps)
    case "email":
      return withTimeout(deps.mailer(channel.smtp, emailMail(channel, message)), deps.timeoutMs)
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}
