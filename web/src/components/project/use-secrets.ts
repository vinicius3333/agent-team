import { toast } from "sonner"
import { api } from "@/api/client"
import type { ProjectSecret, ProjectSecrets } from "@/api/types"
import { usePolled } from "@/components/operate/use-operate"
import { useProjectView } from "./context"

export function useProjectSecrets() {
  const { name } = useProjectView()
  const { value, error, refresh } = usePolled<ProjectSecrets>(() => api.secrets(name), name)
  const liveUrl = value?.url ?? null

  const report = (started: boolean, done: string) => {
    toast.success(started ? `${done} Every secret is set, so the deploy resumes.` : done)
    void refresh()
  }
  const failed = (fallback: string) => (reason: unknown) => {
    toast.error(reason instanceof Error ? reason.message : fallback)
    throw reason
  }

  return {
    secrets: value,
    error,
    refresh,
    liveUrl,
    save: (secret: string, input: string) => api.saveSecret(name, secret, input).then(({ started }) => report(started, `${secret} saved.`), failed(`Could not save ${secret}.`)),
    remove: (secret: string) => api.deleteSecret(name, secret).then(({ started }) => report(started, `${secret} removed.`), failed(`Could not remove ${secret}.`)),
    skip: (secret: string, skipped: boolean) =>
      api.skipSecret(name, secret, skipped).then(({ started }) => report(started, skipped ? `${secret} skipped. The app keeps its fake.` : `${secret} is needed again.`), failed(`Could not update ${secret}.`)),
    skipAll: async (names: string[]) => {
      let started = false
      for (const secret of names) started = (await api.skipSecret(name, secret, true).catch(failed(`Could not skip ${secret}.`))).started || started
      report(started, `Skipped ${names.join(", ")}.`)
    },
    redeploy: () => api.redeploy(name).then(() => toast.success("Redeploy started. The app restarts with the saved values."), failed("Could not start the redeploy.")),
  }
}

// Agents write the redirect URI as <APP_URL>/path; show the real address once the app is live.
export function describeSecret(secret: ProjectSecret, liveUrl: string | null): string {
  return liveUrl ? secret.description.replaceAll("<APP_URL>", liveUrl) : secret.description
}

export function secretState(secret: ProjectSecret): { status: string; label: string } {
  if (secret.source === "project") return { status: "saved", label: secret.declared ? "Set" : "Set · not declared" }
  if (secret.source === "global") return { status: "shared", label: "Shared" }
  if (secret.skipped) return { status: "skipped", label: secret.optional ? "Optional · skipped" : "Skipped" }
  return secret.optional ? { status: "pending", label: "Optional" } : { status: "unset", label: "Missing" }
}
