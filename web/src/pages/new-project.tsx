import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { Bot, Boxes, Cloud, Code2, Globe, Image, Layers, ListTodo, Loader2, Palette, Play, ShieldCheck, User, Users, Zap } from "lucide-react"
import { toast } from "sonner"
import { ApiError, api } from "@/api/client"
import { useAsync } from "@/api/hooks"
import { useProjectList } from "@/api/projects-context"
import { planningPhases, type Defaults, type PlanningPhase, type RunnerName, type Target } from "@/api/types"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
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

const providers: { value: RunnerName; label: string; hint: string }[] = [
  { value: "claude", label: "Claude", hint: "Workers run on Claude Sonnet." },
  {
    value: "codex",
    label: "Codex",
    hint: "Workers run on Codex GPT-5.5. Codex reports no cost.",
  },
]

const gateHints: Record<PlanningPhase, string> = {
  spec: "Review the product spec before the architecture.",
  architecture: "Review the technical plan before design.",
  mockups: "Review the mockup images before design.",
  design: "Review the UI design before the build.",
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
    hint: "Draws UI mockups.",
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

// The server writes this worker model into pipeline.yaml when the user picks Codex (src/project.ts).
const codexWorker = "codex gpt-5.5"

function roleModel(role: string, workerRunner: RunnerName, defaults: Defaults | null): string | null {
  if (role === "deploy") return "this server"
  if (role === "worker" && workerRunner === "codex") return codexWorker
  const config = defaults?.roles[role]
  return config ? `${config.runner} ${config.model}` : null
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

export function NewProjectPage() {
  const navigate = useNavigate()
  const { refresh } = useProjectList()
  const [name, setName] = useState("")
  const [brief, setBrief] = useState("")
  const [target, setTarget] = useState<Target>("web")
  const [workerRunner, setWorkerRunner] = useState<RunnerName>("claude")
  const [gates, setGates] = useState<PlanningPhase[]>(["spec", "design"])
  const [github, setGithub] = useState(false)
  const [deploy, setDeploy] = useState(true)
  const [mockups, setMockups] = useState(true)
  const [errors, setErrors] = useState<FormErrors>({})
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const defaults = useAsync(api.defaults, [])

  const liveErrors = touched ? validate(name, brief) : {}
  const shownErrors = { ...errors, ...liveErrors }

  const toggleGate = (phase: PlanningPhase, checked: boolean) => setGates((current) => (checked ? [...current, phase] : current.filter((gate) => gate !== phase)))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    const found = validate(name, brief)
    setErrors(found)
    if (Object.keys(found).length) return
    setSubmitting(true)
    try {
      const orderedGates = planningPhases.filter((phase) => gates.includes(phase) && (mockups || phase !== "mockups"))
      const created = await api.createProject({
        name,
        brief,
        target,
        workerRunner,
        gates: orderedGates,
        github,
        deploy,
        mockups,
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
  const providerHint = providers.find((option) => option.value === workerRunner)?.hint

  return (
    <>
      <PageHeader title="New project" description="Describe your idea. Your team will build it." />
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
                <ToggleGroup type="single" variant="outline" value={target} onValueChange={(value) => value && setTarget(value as Target)} className="w-full sm:w-fit" aria-describedby="target-help">
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
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Worker provider</legend>
                <ToggleGroup type="single" variant="outline" value={workerRunner} onValueChange={(value) => value && setWorkerRunner(value as RunnerName)} className="w-full sm:w-fit" aria-describedby="provider-help">
                  {providers.map((option) => (
                    <ToggleGroupItem key={option.value} value={option.value} className="flex-1 px-5 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground sm:flex-none">
                      {option.value === "claude" ? <Zap /> : <Bot />} {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <p id="provider-help" className="text-xs text-muted-foreground">
                  {providerHint}
                </p>
              </fieldset>
              <fieldset>
                <legend className="mb-1 text-sm font-medium">Approval gates</legend>
                <p className="mb-3 text-xs text-muted-foreground">The build pauses after each checked step until you approve it.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {planningPhases.map((phase) => {
                    const disabled = phase === "mockups" && !mockups
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
                    id: "option-mockups",
                    label: "Draw mockups",
                    hint: "The illustrator draws UI images before the design step.",
                    checked: mockups,
                    set: setMockups,
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
                const model = roleModel(role.role, workerRunner, defaults.value)
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
              <p className="text-xs">You can change models later in the project's pipeline.yaml.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
