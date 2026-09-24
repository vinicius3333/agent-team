import { useCallback, useEffect, useState } from "react"
import { Loader2, Send } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { NotificationChannel, NotificationStatus } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { formatRelative } from "@/lib/format"

const typeLabels: Record<NotificationChannel["type"], string> = { webhook: "Webhook", slack: "Slack", ntfy: "ntfy", email: "Email" }

const exampleConfig = `dashboardUrl: https://your-host.ts.net:4400
channels:
  - name: phone
    type: ntfy
    topic: agent-team-\${NTFY_TOPIC_SUFFIX}
    events: [gate, budget, qa_failed, paused, failed]`

function deliveryStatus(channel: NotificationChannel): { tone: string; text: string } {
  if (!channel.enabled) return { tone: "bg-muted-foreground", text: `Off: ${channel.offReason}` }
  const failedLast = channel.lastError && (!channel.lastSuccessAt || channel.lastError.at > channel.lastSuccessAt)
  if (failedLast) return { tone: "bg-destructive", text: `Failed ${formatRelative(channel.lastError!.at)}: ${channel.lastError!.message}` }
  if (channel.lastSuccessAt) return { tone: "bg-success", text: `Delivered ${formatRelative(channel.lastSuccessAt)}` }
  return { tone: "bg-muted-foreground", text: "Nothing sent yet" }
}

function ChannelRow({ channel, busy, onTest }: { channel: NotificationChannel; busy: boolean; onTest: () => void }) {
  const status = deliveryStatus(channel)
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="grid min-w-0 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{channel.name}</span>
          <Badge variant="outline">{typeLabels[channel.type]}</Badge>
          {channel.target && <code className="truncate font-mono text-xs text-muted-foreground">{channel.target}</code>}
        </div>
        {channel.events.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {channel.events.map((kind) => (
              <Badge key={kind} variant="secondary" className="font-mono">
                {kind}
              </Badge>
            ))}
            {channel.projects && <span className="text-xs text-muted-foreground">only {channel.projects.join(", ")}</span>}
          </div>
        )}
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <span className={`mt-1.5 size-2 shrink-0 rounded-full ${status.tone}`} aria-hidden />
          <span className="break-words">{status.text}</span>
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onTest} disabled={busy} className="shrink-0 self-start">
        {busy ? <Loader2 className="animate-spin" /> : <Send />} Send test
      </Button>
    </li>
  )
}

export function NotificationsCard() {
  const [status, setStatus] = useState<NotificationStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.notifications())
      setLoadError(null)
    } catch (error) {
      setLoadError((error as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const test = async (channel?: string) => {
    setTesting(channel ?? "all")
    try {
      const results = await api.testNotifications(channel)
      for (const result of results) {
        if (result.ok) toast.success(`Test sent to ${result.channel}`)
        else toast.error(`${result.channel}: ${result.error}`)
      }
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setTesting(null)
      void refresh()
    }
  }

  const channels = status?.channels ?? []
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>Notifications</CardTitle>
          <CardDescription>Messages when a run needs you: a gate, the budget, a failure, or a live app.</CardDescription>
        </div>
        {channels.length > 1 && (
          <Button variant="outline" size="sm" onClick={() => test()} disabled={testing !== null}>
            {testing === "all" ? <Loader2 className="animate-spin" /> : <Send />} Send test to all
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {loadError && <p className="text-sm text-destructive">Could not load notification settings: {loadError}</p>}
        {status?.error && <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-destructive/50 p-3 text-xs text-destructive">{status.error}</pre>}
        {channels.length > 0 && (
          <ul className="divide-y">
            {channels.map((channel) => (
              <ChannelRow key={channel.name} channel={channel} busy={testing === channel.name || testing === "all"} onTest={() => test(channel.name)} />
            ))}
          </ul>
        )}
        {status && !status.error && (
          <div className="grid gap-2 rounded-md border bg-muted/40 p-3 text-sm">
            <p>
              {status.configured ? "To add or change a channel, edit" : "Notifications are off. To turn them on, create"} <code className="font-mono text-xs">notifications.yaml</code> in the runs folder. Secrets go in environment variables as <code className="font-mono text-xs">{"${NAME}"}</code>.
            </p>
            <pre className="overflow-x-auto rounded bg-background p-3 font-mono text-xs">{exampleConfig}</pre>
            <p className="text-muted-foreground">Changes apply within 15 seconds. Reload this page to see them.</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
