import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Loader2, Lock, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import type { SharedSecrets } from "@/api/types"
import { SecretValueForm } from "@/components/secret-value-form"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { formatRelative } from "@/lib/format"

function UsedBy({ projects }: { projects: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <span>{projects.length ? "Used by" : "No project declares it"}</span>
      {projects.map((project) => (
        <Badge key={project} variant="secondary">
          {project}
        </Badge>
      ))}
    </div>
  )
}

export function SharedSecretsCard() {
  const [view, setView] = useState<SharedSecrets | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(() => {
    api.sharedSecrets().then(setView, (error) => toast.error(error instanceof Error ? error.message : "Could not load the shared secrets."))
  }, [])
  useEffect(refresh, [refresh])

  const save = async (secret: string, input: string) => {
    try {
      const { resumed } = await api.saveSharedSecret(secret, input)
      toast.success(resumed.length ? `${secret} saved. Deploy resumes for ${resumed.join(", ")}.` : `${secret} saved.`)
      refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not save ${secret}.`)
      throw error
    }
  }
  const remove = async (secret: string) => {
    try {
      await api.deleteSharedSecret(secret)
      toast.success(`${secret} removed. Apps keep it until their next deploy.`)
      refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not remove ${secret}.`)
    }
  }
  const add = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await save(name, value)
      setName("")
      setValue("")
      setAdding(false)
    } catch {
      // Already reported; keep the input for a retry.
    } finally {
      setBusy(false)
    }
  }

  const keyReason = view && view.key.state !== "ready" ? view.key.error : null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Shared secrets</CardTitle>
        <CardDescription>Values every project can use. A project gets one only when its .env.example declares it, and a project value overrides it.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {view &&
          (keyReason ? (
            <p role="alert" className="text-sm text-destructive">
              {keyReason} Restart the dashboard and the doctor after you set it.
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-sm text-success">
              <Lock className="size-4" aria-hidden="true" /> Encrypted with AGENT_TEAM_SECRETS_KEY
            </p>
          ))}
        {view && view.secrets.length > 0 && (
          <ul className="divide-y border-y">
            {view.secrets.map((secret) => (
              <li key={secret.name} className="flex items-start justify-between gap-3 py-3">
                <div className="grid min-w-0 gap-1">
                  <code className="font-mono text-sm font-medium break-all">{secret.name}</code>
                  <UsedBy projects={secret.usedBy} />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="hidden text-xs text-muted-foreground sm:inline">Updated {formatRelative(secret.updatedAt)}</span>
                  <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label={`Remove ${secret.name}`} title={`Remove ${secret.name}`} onClick={() => void remove(secret.name)}>
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {view && view.wanted.length > 0 && (
          <div className="grid gap-2">
            <p className="text-sm font-medium">Requested by projects</p>
            <ul className="divide-y border-y">
              {view.wanted.map((secret) => (
                <li key={secret.name} className="flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="grid min-w-0 gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-sm font-medium break-all">{secret.name}</code>
                      <StatusBadge status="unset" label="No value" />
                    </div>
                    <UsedBy projects={secret.usedBy} />
                  </div>
                  <SecretValueForm name={secret.name} onSave={(input) => save(secret.name, input)} disabledReason={keyReason} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {adding ? (
          <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
            <Input aria-label="Secret name" placeholder="NAME" value={name} onChange={(event) => setName(event.target.value.toUpperCase())} className="h-11 font-mono placeholder:font-sans sm:h-9 sm:w-56" />
            <Input type="password" autoComplete="off" aria-label="Secret value" placeholder="Paste value" value={value} onChange={(event) => setValue(event.target.value)} className="h-11 font-mono placeholder:font-sans sm:h-9 sm:flex-1" />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !name || !value} className="h-11 flex-1 sm:h-9 sm:flex-none">
                {busy && <Loader2 className="animate-spin" />} Save
              </Button>
              <Button type="button" variant="ghost" className="h-11 flex-1 sm:h-9 sm:flex-none" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="link" className="h-11 justify-self-start px-0 sm:h-9" onClick={() => setAdding(true)} disabled={Boolean(keyReason)} title={keyReason ?? undefined}>
            <Plus /> Add a shared secret
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
