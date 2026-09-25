import { Check, Container, FileText, GitBranch, MessageSquare, Network, Play, Shuffle, type LucideIcon } from "lucide-react"
import { CodeBlock } from "@/components/code-block"
import { PixelCluster } from "@/components/pixel-art"
import { SectionHeading } from "@/components/section-heading"

const guarantees: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: GitBranch, title: "A fresh worktree per attempt", text: "A failed attempt is thrown away and never touches main." },
  { icon: Container, title: "A locked-down container", text: "Read-only root, no capabilities, CPU and memory limits." },
  { icon: Network, title: "No open internet", text: "Only an allowlist: Claude, OpenAI, npm, PyPI, GitHub." },
  { icon: Shuffle, title: "Fallbacks on limits", text: "A rate limit or timeout moves the role to its next model." },
]

const rolesYaml = `roles:
  pm:          { runner: claude, model: opus }
  illustrator: { runner: codex, model: gpt-6-astra }
  worker:      { runner: claude, model: claude-opus-5-5 }`

const examplePhases = [
  { name: "spec", status: "Waiting for you" },
  { name: "architecture", status: "Pending" },
  { name: "concepts", status: "Pending" },
  { name: "branding", status: "Pending" },
]

function RunStatusCard() {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold">Run pipeline</h3>
        <span className="font-mono text-xs text-muted-foreground">Phase 1 of 10</span>
      </div>
      <ol className="flex flex-col">
        {examplePhases.map((phase, index) => {
          const waiting = index === 0
          return (
            <li key={phase.name} className="relative flex items-center gap-3 py-2 text-sm">
              {index < examplePhases.length - 1 && <span className="absolute top-7 left-[9px] h-4 w-px bg-border" aria-hidden="true" />}
              <span className={`grid size-[19px] place-items-center rounded-full border-2 ${waiting ? "border-primary" : "border-muted-foreground/40"}`}>
                {waiting && <span className="size-2 rounded-full bg-primary" />}
              </span>
              <span className="flex-1 font-mono">{phase.name}</span>
              <span className={waiting ? "font-medium text-primary" : "text-muted-foreground"}>{phase.status}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function ApprovalCard() {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5">
      <h3 className="font-semibold">Spec is waiting for you</h3>
      <div className="flex flex-wrap gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2 py-1 font-mono text-xs text-accent-foreground">
          <Check size={12} /> gate: spec
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2 py-1 font-mono text-xs text-accent-foreground">
          <FileText size={12} /> docs/spec.md
        </span>
      </div>
      <div className="mt-auto flex flex-col gap-2" aria-hidden="true">
        <span className="flex items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground">
          <Play size={15} /> Approve
        </span>
        <span className="flex items-center justify-center gap-2 rounded-lg border border-primary/50 py-2.5 text-sm font-medium text-primary">
          <MessageSquare size={15} /> Request changes
        </span>
      </div>
    </div>
  )
}

export function RunnersSection() {
  return (
    <section id="runners" className="relative scroll-mt-8 overflow-hidden py-24 sm:py-32">
      <PixelCluster className="top-10 right-6 hidden sm:block" />
      <div className="relative mx-auto flex max-w-6xl flex-col gap-14 px-4 sm:px-6">
        <SectionHeading eyebrow="Self-hosted" title="Runs on your machine, with your CLIs.">
          agent-team drives the Claude Code and Codex CLIs you already have logged in. Every role can use either runner and its own model.
        </SectionHeading>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {guarantees.map((guarantee) => {
              const Icon = guarantee.icon
              return (
                <li key={guarantee.title} className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-6">
                  <Icon size={28} strokeWidth={1.75} className="text-primary" />
                  <h3 className="mt-2 text-lg leading-snug font-semibold">{guarantee.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{guarantee.text}</p>
                </li>
              )
            })}
          </ul>
          <div className="flex min-w-0 flex-col gap-5">
            <CodeBlock title="pipeline.yaml" copyText={rolesYaml} code={rolesYaml} language="yaml" />
            <div className="flex flex-col gap-2">
              <span className="font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">From the dashboard</span>
              <div className="grid flex-1 grid-cols-1 gap-5 sm:grid-cols-2">
                <RunStatusCard />
                <ApprovalCard />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
