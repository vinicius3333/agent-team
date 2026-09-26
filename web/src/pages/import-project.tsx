import { useMemo, useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { Boxes, ChevronDown, Code2, Download, Folder, GitBranch, Globe, Layers, Loader2, Plus, Search, ShieldCheck, User, X, Zap } from "lucide-react"
import { toast } from "sonner"
import { ApiError, api } from "@/api/client"
import { useAsync } from "@/api/hooks"
import { useProjectList } from "@/api/projects-context"
import { importGates, type ImportGitHubMode, type Target } from "@/api/types"
import { PageHeader } from "@/components/page-header"
import { invalidRoles, pickEditable, RoleModelsEditor, type RoleModels } from "@/components/role-models-editor"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { stepLabels } from "@/lib/pipeline"
import { cn } from "@/lib/utils"

const namePattern = /^[a-z0-9][a-z0-9-]{1,40}$/
const gitUrlPattern = /^(https?:\/\/|ssh:\/\/|git@)\S+$/
const httpUrlPattern = /^https?:\/\/\S+$/
const maxUrls = 10

type SourceKind = "git" | "folder"
type ImportGate = (typeof importGates)[number]

const targets: { value: Target; label: string; icon: typeof Globe }[] = [
  { value: "web", label: "Web app", icon: Globe },
  { value: "api", label: "API", icon: Code2 },
  { value: "web+api", label: "Web + API", icon: Layers },
]

const githubModes: { value: ImportGitHubMode; label: string; hint: string }[] = [
  { value: "source", label: "Source repo", hint: "Changes open issues and pull requests on the repository you import. Needs push access." },
  { value: "new", label: "New repo", hint: "Creates a new repository with the imported history, as for a new project." },
  { value: "none", label: "None", hint: "Keeps everything in the local git repository." },
]

const gateHints: Record<ImportGate, string> = {
  spec: "Review how the spec describes the app before the architecture.",
  architecture: "Review the recorded stack and commands before the design step.",
  design: "Review the extracted design system before the baseline.",
}

const importTeam = [
  { name: "Importer", role: "importer", hint: "Reads the code and your URLs.", icon: Search, color: "text-chart-1 bg-chart-1/10" },
  { name: "PM", role: "pm", hint: "Describes the app as it is.", icon: User, color: "text-chart-2 bg-chart-2/10" },
  { name: "Architect", role: "architect", hint: "Records the stack and commands.", icon: Boxes, color: "text-chart-3 bg-chart-3/10" },
  { name: "Designer", role: "designer", hint: "Extracts the existing design.", icon: Layers, color: "text-chart-5 bg-chart-5/10" },
  { name: "Baseline", role: null, hint: "The orchestrator runs the tests and screenshots every route.", icon: ShieldCheck, color: "text-chart-4 bg-chart-4/10" },
]

interface FormErrors {
  name?: string
  source?: string
  urls?: string
  form?: string
}

function validate(name: string, kind: SourceKind, source: string, urls: string[], github: ImportGitHubMode): FormErrors {
  const errors: FormErrors = {}
  if (!namePattern.test(name)) errors.name = "Use 2 to 41 characters: lowercase letters, digits, and dashes. Start with a letter or digit."
  const trimmed = source.trim()
  if (!trimmed) errors.source = kind === "git" ? "Paste the repository URL." : "Type the folder's full path."
  else if (kind === "git" && !gitUrlPattern.test(trimmed)) errors.source = "Use an https, ssh, or git@ URL."
  else if (kind === "folder" && !trimmed.startsWith("/")) errors.source = "Use the full path, starting with /."
  else if (github === "source" && !/github\.com[/:]/.test(trimmed)) errors.source = "Only a GitHub URL can use the source repo for pull requests."
  const filled = urls.map((url) => url.trim()).filter(Boolean)
  if (filled.some((url) => !httpUrlPattern.test(url))) errors.urls = "Each URL must start with http:// or https://."
  return errors
}

export function ImportProjectPage() {
  const navigate = useNavigate()
  const { refresh } = useProjectList()
  const [name, setName] = useState("")
  const [kind, setKind] = useState<SourceKind>("git")
  const [source, setSource] = useState("")
  const [urls, setUrls] = useState<string[]>([""])
  const [github, setGithub] = useState<ImportGitHubMode>("none")
  const [target, setTarget] = useState<Target>("web")
  const [gates, setGates] = useState<ImportGate[]>(["spec"])
  const [deploy, setDeploy] = useState(false)
  const [roleEdits, setRoleEdits] = useState<RoleModels>({})
  const [customizing, setCustomizing] = useState(false)
  const [errors, setErrors] = useState<FormErrors>({})
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const defaults = useAsync(api.defaults, [])
  const defaultModels = useMemo(() => (defaults.value ? pickEditable(defaults.value.roles) : {}), [defaults.value])
  const models: RoleModels = { ...defaultModels, ...roleEdits }
  const fallbacks = Object.fromEntries(Object.entries(defaults.value?.roles ?? {}).map(([role, config]) => [role, config.fallbacks]))

  const shownErrors = { ...errors, ...(touched ? validate(name, kind, source, urls, github) : {}) }

  const changeKind = (next: SourceKind) => {
    setKind(next)
    if (next === "folder" && github === "source") setGithub("none")
  }
  const setUrl = (index: number, value: string) => setUrls((current) => current.map((url, position) => (position === index ? value : url)))
  const removeUrl = (index: number) => setUrls((current) => (current.length === 1 ? [""] : current.filter((_, position) => position !== index)))
  const toggleGate = (gate: ImportGate, checked: boolean) => setGates((current) => (checked ? [...current, gate] : current.filter((entry) => entry !== gate)))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    const found = validate(name, kind, source, urls, github)
    setErrors(found)
    if (Object.keys(found).length) return
    if (invalidRoles(models).length) {
      setCustomizing(true)
      setErrors({ form: "Fix the model names under Agent models." })
      return
    }
    setSubmitting(true)
    try {
      const created = await api.importProject({
        name,
        source: source.trim(),
        urls: urls.map((url) => url.trim()).filter(Boolean),
        github,
        target,
        gates: importGates.filter((gate) => gates.includes(gate)),
        deploy,
        roles: models,
      })
      toast.success(`Importing ${created.name}`)
      void refresh()
      navigate(`/projects/${encodeURIComponent(created.name)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "The project could not be imported."
      setErrors(error instanceof ApiError && error.status === 409 ? { name: message } : { form: message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <PageHeader title="Import project" description="Bring an existing app into your agent team. The team studies it, then takes change requests." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardContent>
            <form onSubmit={submit} noValidate className="flex flex-col gap-6">
              {shownErrors.form && (
                <Alert variant="destructive">
                  <AlertDescription>{shownErrors.form}</AlertDescription>
                </Alert>
              )}
              <div className="grid gap-2">
                <Label htmlFor="import-name">Project name</Label>
                <Input
                  id="import-name"
                  value={name}
                  onChange={(event) => setName(event.target.value.toLowerCase())}
                  placeholder="invoicer"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(shownErrors.name)}
                  aria-describedby="import-name-help"
                />
                <p id="import-name-help" className={cn("text-xs", shownErrors.name ? "text-destructive" : "text-muted-foreground")}>
                  {shownErrors.name ?? "Lowercase letters, digits, and dashes. This is also the folder name."}
                </p>
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Source</legend>
                <ToggleGroup type="single" variant="outline" value={kind} onValueChange={(value) => value && changeKind(value as SourceKind)} className="w-full sm:w-fit">
                  <ToggleGroupItem value="git" className="flex-1 gap-2 px-4 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground sm:flex-none">
                    <GitBranch /> Git URL
                  </ToggleGroupItem>
                  <ToggleGroupItem value="folder" className="flex-1 gap-2 px-4 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground sm:flex-none">
                    <Folder /> Local folder
                  </ToggleGroupItem>
                </ToggleGroup>
                <Input
                  id="import-source"
                  aria-label={kind === "git" ? "Repository URL" : "Folder path"}
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder={kind === "git" ? "https://github.com/acme/invoicer" : "/home/me/code/invoicer"}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={Boolean(shownErrors.source)}
                  aria-describedby="import-source-help"
                />
                <p id="import-source-help" className={cn("text-xs", shownErrors.source ? "text-destructive" : "text-muted-foreground")}>
                  {shownErrors.source ?? (kind === "git" ? "The team clones it. The server's git and gh logins are used." : "The team copies it with its git history. The folder itself never changes.")}
                </p>
              </fieldset>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Extra URLs (optional)</legend>
                {urls.map((url, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      aria-label={`Extra URL ${index + 1}`}
                      value={url}
                      onChange={(event) => setUrl(index, event.target.value)}
                      placeholder={index === 0 ? "https://invoicer.app" : "https://docs.invoicer.app"}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={Boolean(shownErrors.urls) && Boolean(url.trim()) && !httpUrlPattern.test(url.trim())}
                    />
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeUrl(index)} aria-label={`Remove extra URL ${index + 1}`}>
                      <X />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => setUrls((current) => [...current, ""])} disabled={urls.length >= maxUrls}>
                  <Plus /> Add URL
                </Button>
                <p className={cn("text-xs", shownErrors.urls ? "text-destructive" : "text-muted-foreground")}>
                  {shownErrors.urls ?? "The live site, the docs, or anything else that explains the product. The importer reads each one."}
                </p>
              </fieldset>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Target</legend>
                <ToggleGroup type="single" variant="outline" value={target} onValueChange={(value) => value && setTarget(value as Target)} className="w-full sm:w-fit">
                  {targets.map((option) => (
                    <ToggleGroupItem key={option.value} value={option.value} className="min-w-0 flex-1 gap-1 px-1.5 text-xs sm:gap-2 sm:text-sm data-[state=on]:bg-accent data-[state=on]:text-accent-foreground sm:flex-none sm:px-5">
                      <option.icon /> {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <p className="text-xs text-muted-foreground">An API has no screens, so the baseline runs only its tests.</p>
              </fieldset>
              <fieldset className="grid gap-3">
                <legend className="mb-2 text-sm font-medium">GitHub destination</legend>
                {githubModes.map((mode) => {
                  const disabled = mode.value === "source" && kind === "folder"
                  return (
                    <label key={mode.value} className={cn("flex cursor-pointer items-start gap-3", disabled && "cursor-not-allowed opacity-50")}>
                      <input type="radio" name="github" value={mode.value} checked={github === mode.value} disabled={disabled} onChange={() => setGithub(mode.value)} className="size-6 shrink-0 accent-primary sm:mt-1 sm:size-4" />
                      <span className="grid gap-0.5">
                        <span className="text-sm font-medium">{mode.label}</span>
                        <span className="text-xs text-muted-foreground">{disabled ? "Needs a GitHub URL." : mode.hint}</span>
                      </span>
                    </label>
                  )
                })}
              </fieldset>
              <section className="grid gap-2" aria-labelledby="import-models-heading">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 id="import-models-heading" className="text-sm font-medium">
                      Agent models
                    </h2>
                    <p className="text-xs text-muted-foreground">The defaults work well. Change a role only if you need to.</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setCustomizing((open) => !open)} aria-expanded={customizing} aria-controls="import-models-editor" disabled={!defaults.value}>
                    Customize <ChevronDown className={cn("transition-transform", customizing && "rotate-180")} />
                  </Button>
                </div>
                {customizing && defaults.value && (
                  <div id="import-models-editor">
                    <RoleModelsEditor value={models} fallbacks={fallbacks} onChange={setRoleEdits} />
                  </div>
                )}
              </section>
              <fieldset>
                <legend className="mb-1 text-sm font-medium">Approval gates</legend>
                <p className="mb-3 text-xs text-muted-foreground">The import pauses after each checked step until you approve it.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {importGates.map((gate) => (
                    <div key={gate} className="flex items-start gap-3">
                      <Checkbox id={`import-gate-${gate}`} checked={gates.includes(gate)} onCheckedChange={(checked) => toggleGate(gate, checked === true)} aria-describedby={`import-gate-${gate}-help`} />
                      <div className="grid gap-0.5">
                        <Label htmlFor={`import-gate-${gate}`} className="min-h-6 sm:min-h-4">After {stepLabels[gate].toLowerCase()}</Label>
                        <p id={`import-gate-${gate}-help`} className="text-xs text-muted-foreground">
                          {gateHints[gate]}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </fieldset>
              <div className="flex items-start gap-3">
                <Switch id="import-deploy" checked={deploy} onCheckedChange={setDeploy} aria-describedby="import-deploy-help" />
                <div className="grid gap-0.5">
                  <Label htmlFor="import-deploy">Deploy changes</Label>
                  <p id="import-deploy-help" className="text-xs text-muted-foreground">
                    After each change merges, runs the app on this server and shares a public preview link.
                  </p>
                </div>
              </div>
              <Separator />
              <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <Button type="submit" size="lg" disabled={submitting}>
                  {submitting ? <Loader2 className="animate-spin" /> : <Download />}
                  {submitting ? "Importing…" : "Start import"}
                </Button>
                <p className="text-sm text-muted-foreground">Nothing in the app changes during the import.</p>
              </div>
            </form>
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Your import team</CardTitle>
            <CardDescription>Each step documents the app as it is.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y">
              {importTeam.map((member) => {
                const model = member.role ? models[member.role] : null
                return (
                  <li key={member.name} className="flex items-center gap-3 py-2.5">
                    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", member.color)}>
                      <member.icon className="size-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium">{member.name}</span>
                        {!member.role ? (
                          <span className="text-xs text-muted-foreground">no agent</span>
                        ) : model ? (
                          <span className="truncate font-mono text-xs text-muted-foreground">{`${model.runner} ${model.model || "…"}`}</span>
                        ) : (
                          <Skeleton className="h-3.5 w-20" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{member.hint}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
            <div className="mt-4 flex gap-3 rounded-lg bg-accent p-3 text-accent-foreground">
              <Zap className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p className="text-xs">After the import, use Request a change for all further work.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
