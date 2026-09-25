import { useMemo, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router"
import { Atom, Boxes, ChevronDown, Cloud, Code2, Globe, Image, Layers, ListTodo, Megaphone, Loader2, Package, Palette, Play, Server, ShieldCheck, User, Users, Zap } from "lucide-react"
import { toast } from "sonner"
import { ApiError, api } from "@/api/client"
import { useAsync } from "@/api/hooks"
import { useProjectList } from "@/api/projects-context"
import { planningPhases, type PlanningPhase, type StackTemplate, type Target } from "@/api/types"
import { PageHeader } from "@/components/page-header"
import { invalidRoles, pickEditable, RoleModelsEditor, type RoleModels } from "@/components/role-models-editor"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { stepLabels } from "@/lib/pipeline"
import { cn } from "@/lib/utils"

const namePattern = /^[a-z0-9][a-z0-9-]{1,40}$/
const briefLimit = 10_000

const targets: {
  value: Target
  label: string
  hint: string
  icon: typeof Globe
}[] = [
  {
    value: "web",
    label: "Web app",
    hint: "A website people use in their browser.",
    icon: Globe,
  },
  {
    value: "api",
    label: "API",
    hint: "An HTTP API other programs call.",
    icon: Code2,
  },
  {
    value: "web+api",
    label: "Web + API",
    hint: "A website with its own backend API.",
    icon: Layers,
  },
]

const gateHints: Record<PlanningPhase, string> = {
  spec: "Review the product spec before the architecture.",
  architecture: "Review the technical plan before design.",
  branding: "Review the logo and screen images before design.",
  design: "Review the UI design before the build.",
  marketing: "Review the launch images and copy before the plan.",
  plan: "Review the task list before workers start.",
}

const teamRoles = [
  {
    name: "PM",
    role: "pm",
    hint: "Turns your idea into a spec.",
    icon: User,
    color: "text-chart-1 bg-chart-1/10",
  },
  {
    name: "Architect",
    role: "architect",
    hint: "Designs the technical approach.",
    icon: Boxes,
    color: "text-chart-3 bg-chart-3/10",
  },
  {
    name: "Illustrator",
    role: "illustrator",
    hint: "Draws the logo and key screens.",
    icon: Image,
    color: "text-chart-2 bg-chart-2/10",
  },
  {
    name: "Designer",
    role: "designer",
    hint: "Writes the design system.",
    icon: Palette,
    color: "text-chart-5 bg-chart-5/10",
  },
  {
    name: "Marketer",
    role: "marketer",
    hint: "Writes launch copy and picks the images.",
    icon: Megaphone,
    color: "text-chart-3 bg-chart-3/10",
  },
  {
    name: "Planner",
    role: "planner",
    hint: "Breaks work into tasks.",
    icon: ListTodo,
    color: "text-chart-4 bg-chart-4/10",
  },
  {
    name: "Workers",
    role: "worker",
    hint: "Write code and tests.",
    icon: Users,
    color: "text-chart-1 bg-chart-1/10",
  },
  {
    name: "Reviewer",
    role: "reviewer",
    hint: "Checks each change.",
    icon: ShieldCheck,
    color: "text-chart-2 bg-chart-2/10",
  },
  {
    name: "Deploy",
    role: "deploy",
    hint: "Runs the app and shares a link.",
    icon: Cloud,
    color: "text-chart-3 bg-chart-3/10",
  },
]

function roleModel(role: string, models: RoleModels): string | null {
  if (role === "deploy") return "this server"
  const config = models[role]
  return config ? `${config.runner} ${config.model || "…"}` : null
}

interface FormErrors {
  name?: string
  brief?: string
  form?: string
}

function validate(name: string, brief: string): FormErrors {
  const errors: FormErrors = {}
  if (!namePattern.test(name)) errors.name = "Use 2 to 41 characters: lowercase letters, digits, and dashes. Start with a letter or digit."
  if (!brief.trim()) errors.brief = "Describe what you want to build."
  else if (brief.length > briefLimit) errors.brief = `Keep the brief under ${briefLimit.toLocaleString("en-US")} characters.`
  return errors
}

const customStack = "custom"
const stackIcons: Record<string, typeof Globe> = { "node-api": Server, "react-vite": Atom, fullstack: Layers }

interface StackOption {
  name: string
  title: string
  description: string
  badges: string[]
  icon: typeof Globe
  disabled: boolean
}

function StackPicker({ templates, loading, target, value, onChange }: { templates: StackTemplate[]; loading: boolean; target: Target; value: string; onChange: (name: string) => void }) {
  const options: StackOption[] = [
    { name: customStack, title: "Custom", description: "The architect chooses the stack.", badges: [], icon: Boxes, disabled: false },
    ...templates.map((template) => ({
      name: template.name,
      title: template.name,
      description: `${template.title}. ${template.description}`,
      badges: [template.targets.join(", "), `v${template.version}`],
      icon: stackIcons[template.name] ?? Package,
      disabled: !template.targets.includes(target),
    })),
  ]
  return (
    <fieldset className="grid gap-2" aria-describedby="stack-help">
      <legend className="mb-2 text-sm font-medium">Stack</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const checked = value === option.name
          return (
            <label
              key={option.name}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                checked ? "border-primary bg-accent" : "hover:bg-muted/50",
                option.disabled && "cursor-not-allowed bg-muted/40 opacity-60 hover:bg-muted/40",
              )}
            >
              <input type="radio" name="stack" value={option.name} checked={checked} disabled={option.disabled} onChange={() => onChange(option.name)} className="mt-1 size-4 shrink-0 accent-primary" />
              <option.icon className={cn("mt-0.5 size-5 shrink-0", checked ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-sm font-medium">{option.title}</span>
                  <span className="flex gap-1">
                    {option.badges.map((badge) => (
                      <Badge key={badge} variant="secondary" className="font-mono text-[0.7rem]">
                        {badge}
                      </Badge>
                    ))}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">{option.description}</span>
              </span>
            </label>
          )
        })}
        {loading && <Skeleton className="h-20 rounded-lg" />}
      </div>
      <p id="stack-help" className="text-xs text-muted-foreground">
        A template starts from a tested scaffold with fixed commands. Only templates for the chosen target can be picked.
      </p>
    </fieldset>
  )
}

export function NewProjectPage() {
  const navigate = useNavigate()
  const { refresh } = useProjectList()
  const [name, setName] = useState("")
  const [brief, setBrief] = useState("")
  const [target, setTarget] = useState<Target>("web")
  const [roleEdits, setRoleEdits] = useState<RoleModels>({})
  const [customizing, setCustomizing] = useState(false)
  const [gates, setGates] = useState<PlanningPhase[]>(["spec", "design"])
  const [github, setGithub] = useState(false)
  const [deploy, setDeploy] = useState(true)
  const [branding, setBranding] = useState(true)
  const [resolveAllQa, setResolveAllQa] = useState(false)
  const [evolve, setEvolve] = useState(true)
  const [errors, setErrors] = useState<FormErrors>({})
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [template, setTemplate] = useState(customStack)
  const templates = useAsync(api.templates, [])
  const changeTarget = (next: Target) => {
    setTarget(next)
    const chosen = templates.value?.find((option) => option.name === template)
    if (chosen && !chosen.targets.includes(next)) setTemplate(customStack)
  }
  const defaults = useAsync(api.defaults, [])
  const defaultModels = useMemo(() => (defaults.value ? pickEditable(defaults.value.roles) : {}), [defaults.value])
  const models: RoleModels = { ...defaultModels, ...roleEdits }
  const fallbacks = Object.fromEntries(Object.entries(defaults.value?.roles ?? {}).map(([role, config]) => [role, config.fallbacks]))

  const liveErrors = touched ? validate(name, brief) : {}
  const shownErrors = { ...errors, ...liveErrors }

  const toggleGate = (phase: PlanningPhase, checked: boolean) => setGates((current) => (checked ? [...current, phase] : current.filter((gate) => gate !== phase)))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    const found = validate(name, brief)
    setErrors(found)
    if (Object.keys(found).length) return
    if (invalidRoles(models).length) {
      setCustomizing(true)
      setErrors({ form: "Fix the model names under Agent models." })
      return
    }
    setSubmitting(true)
    try {
      const orderedGates = planningPhases.filter((phase) => gates.includes(phase) && (branding || phase !== "branding"))
      const created = await api.createProject({
        name,
        brief,
        target,
        roles: models,
        gates: orderedGates,
        github,
        deploy,
        branding,
        resolveAllQa,
        evolve,
        ...(template === customStack ? {} : { template }),
      })
      toast.success(`Started ${created.name}`)
      void refresh()
      navigate(`/projects/${encodeURIComponent(created.name)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "The project could not be created."
      setErrors(error instanceof ApiError && error.status === 409 ? { name: message } : { form: message })
    } finally {
      setSubmitting(false)
    }
  }

  const targetHint = targets.find((option) => option.value === target)?.hint

  return (
    <>
      <PageHeader
        title="New project"
        description="Describe your idea. Your team will build it."
        actions={
          <Button asChild variant="outline">
            <Link to="/import">Import an existing app</Link>
          </Button>
        }
      />
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
                <Label htmlFor="project-name">Project name</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(event) => setName(event.target.value.toLowerCase())}
                  placeholder="dad-jokes"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(shownErrors.name)}
                  aria-describedby="project-name-help"
                />
                <p id="project-name-help" className={cn("text-xs", shownErrors.name ? "text-destructive" : "text-muted-foreground")}>
                  {shownErrors.name ?? "Lowercase letters, digits, and dashes. This is also the folder and repo name."}
                </p>
              </div>
              <div className="grid gap-2">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor="project-brief">Product brief</Label>
                  <span className={cn("text-xs tabular-nums", brief.length > briefLimit ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
                    {brief.length.toLocaleString("en-US")} / {briefLimit.toLocaleString("en-US")}
                  </span>
                </div>
                <Textarea
                  id="project-brief"
                  value={brief}
                  onChange={(event) => setBrief(event.target.value)}
                  placeholder="A dad-jokes site with voting. Visitors submit jokes, upvote their favorites, and browse the top jokes of the week."
                  className="min-h-32"
                  aria-invalid={Boolean(shownErrors.brief)}
                  aria-describedby="project-brief-help"
                />
                <p id="project-brief-help" className={cn("text-xs", shownErrors.brief ? "text-destructive" : "text-muted-foreground")}>
                  {shownErrors.brief ?? "Say who uses it and what they can do. The PM agent turns this into a spec."}
                </p>
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Target</legend>
                <ToggleGroup type="single" variant="outline" value={target} onValueChange={(value) => value && changeTarget(value as Target)} className="w-full sm:w-fit" aria-describedby="target-help">
                  {targets.map((option) => (
                    <ToggleGroupItem key={option.value} value={option.value} className="min-w-0 flex-1 gap-1 px-1.5 text-xs sm:gap-2 sm:text-sm data-[state=on]:bg-accent data-[state=on]:text-accent-foreground sm:flex-none sm:px-5">
                      <option.icon /> {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <p id="target-help" className="text-xs text-muted-foreground">
                  {targetHint}
                </p>
              </fieldset>
              <StackPicker templates={templates.value ?? []} loading={templates.loading} target={target} value={template} onChange={setTemplate} />
              <section className="grid gap-2" aria-labelledby="models-heading">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 id="models-heading" className="text-sm font-medium">
                      Agent models
                    </h2>
                    <p className="text-xs text-muted-foreground">The defaults work well. Change a role only if you need to.</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setCustomizing((open) => !open)} aria-expanded={customizing} aria-controls="models-editor" disabled={!defaults.value}>
                    Customize <ChevronDown className={cn("transition-transform", customizing && "rotate-180")} />
                  </Button>
                </div>
                {customizing && defaults.value && (
                  <div id="models-editor">
                    <RoleModelsEditor value={models} fallbacks={fallbacks} onChange={setRoleEdits} />
                    <p className="text-xs text-muted-foreground">Codex reports no cost, so the run budget does not count it.</p>
                  </div>
                )}
              </section>
              <fieldset>
                <legend className="mb-1 text-sm font-medium">Approval gates</legend>
                <p className="mb-3 text-xs text-muted-foreground">The build pauses after each checked step until you approve it.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {planningPhases.map((phase) => {
                    const disabled = phase === "branding" && !branding
                    return (
                      <div key={phase} className={cn("flex items-start gap-3", disabled && "opacity-50")}>
                        <Checkbox
                          id={`gate-${phase}`}
                          checked={gates.includes(phase) && !disabled}
                          disabled={disabled}
                          onCheckedChange={(checked) => toggleGate(phase, checked === true)}
                          aria-describedby={`gate-${phase}-help`}
                          className="mt-0.5"
                        />
                        <div className="grid gap-0.5">
                          <Label htmlFor={`gate-${phase}`}>After {stepLabels[phase].toLowerCase()}</Label>
                          <p id={`gate-${phase}-help`} className="text-xs text-muted-foreground">
                            {gateHints[phase]}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </fieldset>
              <fieldset className="grid gap-4">
                <legend className="mb-3 text-sm font-medium">Options</legend>
                {[
                  {
                    id: "option-github",
                    label: "Create a GitHub repo",
                    hint: "Adds a repo, an issue per task, pull requests, and a project board.",
                    checked: github,
                    set: setGithub,
                  },
                  {
                    id: "option-deploy",
                    label: "Deploy when ready",
                    hint: "Runs the app on this server and shares a public preview link.",
                    checked: deploy,
                    set: setDeploy,
                  },
                  {
                    id: "option-branding",
                    label: "Draw branding",
                    hint: "The illustrator draws a logo and desktop screens before the design step.",
                    checked: branding,
                    set: setBranding,
                  },
                  {
                    id: "option-resolve-all",
                    label: "Resolve every QA finding",
                    hint: "QA passes only when it has no findings left. Minor ones get fix tasks too.",
                    checked: resolveAllQa,
                    set: setResolveAllQa,
                  },
                  {
                    id: "option-evolve",
                    label: "Keep improving",
                    hint: "After deploy, an evaluator scores the app against the brief and builds what is missing, until it reaches the target score or the budget.",
                    checked: evolve,
                    set: setEvolve,
                  },
                ].map((option) => (
                  <div key={option.id} className="flex items-start gap-3">
                    <Switch id={option.id} checked={option.checked} onCheckedChange={option.set} aria-describedby={`${option.id}-help`} />
                    <div className="grid gap-0.5">
                      <Label htmlFor={option.id}>{option.label}</Label>
                      <p id={`${option.id}-help`} className="text-xs text-muted-foreground">
                        {option.hint}
                      </p>
                    </div>
                  </div>
                ))}
              </fieldset>
              <Separator />
              <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <Button type="submit" size="lg" disabled={submitting}>
                  {submitting ? <Loader2 className="animate-spin" /> : <Play />}
                  {submitting ? "Starting…" : "Start build"}
                </Button>
                <p className="text-sm text-muted-foreground">Your agent team writes a spec, then gets to work.</p>
              </div>
            </form>
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Your agent team</CardTitle>
            <CardDescription>Each role and the model it runs on.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y">
              {teamRoles.map((role) => {
                const model = roleModel(role.role, models)
                return (
                  <li key={role.role} className="flex items-center gap-3 py-2.5">
                    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", role.color)}>
                      <role.icon className="size-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium">{role.name}</span>
                        {model ? (
                          <span className="truncate font-mono text-xs text-muted-foreground">{model}</span>
                        ) : defaults.loading ? (
                          <Skeleton className="h-3.5 w-20" />
                        ) : (
                          <span className="text-xs text-muted-foreground">see pipeline.yaml</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{role.hint}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
            <div className="mt-4 flex gap-3 rounded-lg bg-accent p-3 text-accent-foreground">
              <Zap className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p className="text-xs">You can change models later on the project's Config tab.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
