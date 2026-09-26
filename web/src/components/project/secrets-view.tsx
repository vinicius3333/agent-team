import { useState, type FormEvent } from "react"
import { KeyRound, Loader2, Plus, RotateCw, Trash2 } from "lucide-react"
import type { ProjectSecret } from "@/api/types"
import { CopyButton } from "@/components/copy-button"
import { EmptyState } from "@/components/empty-state"
import { SecretValueForm } from "@/components/secret-value-form"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { formatRelative } from "@/lib/format"
import { useProjectView } from "./context"
import { describeSecret, secretState, useProjectSecrets } from "./use-secrets"

type Secrets = ReturnType<typeof useProjectSecrets>

export function SecretsView() {
  const secrets = useProjectSecrets()
  const view = secrets.secrets
  if (!view) return secrets.error ? <EmptyState title="Secrets did not load">{secrets.error.message}</EmptyState> : null
  const keyReason = view.key.state === "ready" ? null : view.key.error
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Secrets</h2>
        <p className="text-sm text-muted-foreground">Keys the app reads at deploy. The app lists them in .env.example. Values are encrypted and never shown again.</p>
      </div>
      {keyReason && <SecretsKeyAlert reason={keyReason} />}
      {view.deployWaiting && view.missing.length > 0 && (
        <Card role="status" className="flex-row items-start gap-3 border-warning/40 bg-warning/5 px-4 py-3">
          <KeyRound className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
          <div className="grid gap-0.5">
            <p className="font-medium">
              Deploy waits for {view.missing.length} {view.missing.length === 1 ? "secret" : "secrets"}
            </p>
            <p className="text-sm text-muted-foreground">The build uses fakes for these. Enter each value or skip it to go live.</p>
          </div>
        </Card>
      )}
      <Card className="gap-0 pb-2">
        <CardHeader className="pb-3">
          <CardTitle>App secrets</CardTitle>
          {secrets.liveUrl && (
            <p className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
              <span className="shrink-0">Live URL:</span>
              <a href={secrets.liveUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-primary hover:underline">
                {secrets.liveUrl}
              </a>
              <CopyButton value={secrets.liveUrl} label="Copy live URL" />
            </p>
          )}
        </CardHeader>
        <CardContent className="px-0">
          {view.secrets.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">The app declares no secrets. When a task adds one to .env.example, it shows up here.</p>
          ) : (
            <ul className="divide-y border-t">
              {view.secrets.map((secret) => (
                <SecretRow key={secret.name} secret={secret} secrets={secrets} keyReason={keyReason} />
              ))}
            </ul>
          )}
          <AddSecretForm secrets={secrets} keyReason={keyReason} />
        </CardContent>
      </Card>
      {view.live && (
        <Card className="flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">Apply to the live app</p>
            <p className="text-sm text-muted-foreground">Saved values reach the app on the next deploy.</p>
          </div>
          <RedeployButton secrets={secrets} />
        </Card>
      )}
    </div>
  )
}

export function SecretsKeyAlert({ reason }: { reason: string }) {
  return (
    <Card role="alert" className="flex-row items-start gap-3 border-destructive/40 px-4 py-3">
      <KeyRound className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="grid gap-0.5">
        <p className="font-medium">Secrets are locked on this server</p>
        <p className="text-sm text-muted-foreground">{reason} Restart the dashboard and the doctor after you set it.</p>
      </div>
    </Card>
  )
}

function SecretRow({ secret, secrets, keyReason }: { secret: ProjectSecret; secrets: Secrets; keyReason: string | null }) {
  const [editing, setEditing] = useState(false)
  const state = secretState(secret)
  const needsValue = !secret.source && !secret.skipped && !secret.optional
  const showForm = needsValue || editing
  const save = async (value: string) => {
    await secrets.save(secret.name, value)
    setEditing(false)
  }
  return (
    <li className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-start">
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-sm font-medium break-all">{secret.name}</code>
          <StatusBadge status={state.status} label={state.label} />
          {secret.updatedAt && secret.source && (
            <span className="text-xs text-muted-foreground">
              {secret.source === "global" ? "from Settings · " : ""}updated {formatRelative(secret.updatedAt)}
            </span>
          )}
        </div>
        {secret.description && <p className="text-sm break-words text-muted-foreground">{describeSecret(secret, secrets.liveUrl)}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
        {showForm ? (
          <SecretValueForm name={secret.name} onSave={save} disabledReason={keyReason}>
            {needsValue && !editing ? (
              <Button variant="outline" className="h-11 flex-1 sm:h-9 sm:flex-none" onClick={() => void secrets.skip(secret.name, true).catch(() => {})}>
                Skip
              </Button>
            ) : (
              <Button variant="ghost" className="h-11 flex-1 sm:h-9 sm:flex-none" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </SecretValueForm>
        ) : (
          <>
            {secret.skipped && !secret.optional && (
              <Button variant="ghost" className="h-11 sm:h-9" onClick={() => void secrets.skip(secret.name, false).catch(() => {})}>
                Undo skip
              </Button>
            )}
            <Button variant="outline" className="h-11 sm:h-9" onClick={() => setEditing(true)} disabled={Boolean(keyReason)} title={keyReason ?? undefined}>
              {secret.source === "project" ? "Replace" : secret.source === "global" ? "Override" : "Enter value"}
            </Button>
            {secret.source === "project" && (
              <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label={`Remove ${secret.name}`} title={secret.declared ? "Remove this project's value" : "Remove"} onClick={() => void secrets.remove(secret.name).catch(() => {})}>
                <Trash2 />
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

function AddSecretForm({ secrets, keyReason }: { secrets: Secrets; keyReason: string | null }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  if (!open) {
    return (
      <Button variant="link" className="mx-4 mt-2 h-11 sm:h-9" onClick={() => setOpen(true)} disabled={Boolean(keyReason)} title={keyReason ?? undefined}>
        <Plus /> Add a secret the app does not declare
      </Button>
    )
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      await secrets.save(name, value)
      setName("")
      setValue("")
      setOpen(false)
    } catch {
      // Already reported; keep the input for a retry.
    } finally {
      setSaving(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t px-6 pt-4 pb-2 sm:flex-row">
      <Input aria-label="Secret name" placeholder="NAME" value={name} onChange={(event) => setName(event.target.value.toUpperCase())} className="h-11 font-mono placeholder:font-sans sm:h-9 sm:w-56" />
      <Input type="password" autoComplete="off" aria-label="Secret value" placeholder="Paste value" value={value} onChange={(event) => setValue(event.target.value)} className="h-11 font-mono placeholder:font-sans sm:h-9 sm:flex-1" />
      <div className="flex gap-2">
        <Button type="submit" disabled={saving || !name || !value} className="h-11 flex-1 sm:h-9 sm:flex-none">
          {saving && <Loader2 className="animate-spin" />} Save
        </Button>
        <Button type="button" variant="ghost" className="h-11 flex-1 sm:h-9 sm:flex-none" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function RedeployButton({ secrets }: { secrets: Secrets }) {
  const { detail } = useProjectView()
  const [busy, setBusy] = useState(false)
  const blocked = detail.active ? "A run is in progress. Redeploy after it stops." : null
  const redeploy = async () => {
    setBusy(true)
    try {
      await secrets.redeploy()
    } catch {
      // Already reported.
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button variant="outline" className="h-11 sm:h-9" onClick={redeploy} disabled={busy || Boolean(blocked)} title={blocked ?? undefined}>
      {busy ? <Loader2 className="animate-spin" /> : <RotateCw />} Redeploy now
    </Button>
  )
}
