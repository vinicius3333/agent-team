import { useState } from "react"
import { KeyRound, Loader2 } from "lucide-react"
import { Link } from "react-router"
import { SecretValueForm } from "@/components/secret-value-form"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { projectPath } from "@/lib/navigation"
import { useProjectView } from "./context"
import { SecretsKeyAlert } from "./secrets-view"
import { describeSecret, useProjectSecrets } from "./use-secrets"

// Shown instead of the approve panel while deploy waits for secrets: the gate opens when the last one is saved or skipped.
export function SecretsGateCard() {
  const { name } = useProjectView()
  const secrets = useProjectSecrets()
  const [skipping, setSkipping] = useState(false)
  const view = secrets.secrets
  if (!view) return null
  const missing = view.secrets.filter((secret) => view.missing.includes(secret.name))
  const keyReason = view.key.state === "ready" ? null : view.key.error
  const skipAll = async () => {
    setSkipping(true)
    try {
      await secrets.skipAll(view.missing)
    } catch {
      // Already reported.
    } finally {
      setSkipping(false)
    }
  }
  return (
    <Card role="status" className="gap-4 border-l-4 border-l-warning px-4 py-4 sm:px-6">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-warning/10 text-warning">
          <KeyRound className="size-5" aria-hidden="true" />
        </span>
        <div className="grid gap-0.5">
          <p className="font-semibold">Deploy waits for secrets</p>
          <p className="text-sm text-muted-foreground">QA passed. The app uses fakes until you enter these keys or skip them.</p>
        </div>
      </div>
      {keyReason && <SecretsKeyAlert reason={keyReason} />}
      <ul className="grid gap-3">
        {missing.map((secret) => (
          <li key={secret.name} className="grid gap-2 rounded-lg border bg-muted/30 p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="grid min-w-0 gap-0.5">
              <code className="font-mono text-sm font-medium break-all">{secret.name}</code>
              {secret.description && <p className="text-xs break-words text-muted-foreground">{describeSecret(secret, secrets.liveUrl)}</p>}
            </div>
            <SecretValueForm name={secret.name} onSave={(value) => secrets.save(secret.name, value)} disabledReason={keyReason} />
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" className="h-11 sm:h-9" onClick={skipAll} disabled={skipping} title="Skip every missing secret and deploy with the fakes">
          {skipping && <Loader2 className="animate-spin" />} Deploy with fakes
        </Button>
        <Button variant="link" asChild className="h-11 sm:h-9">
          <Link to={projectPath(name, "launch", "secrets")}>Open Secrets</Link>
        </Button>
      </div>
    </Card>
  )
}
