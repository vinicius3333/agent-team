import { RefreshCw } from "lucide-react"
import { PixelCluster, PixelIcon, type PixelIconName } from "@/components/pixel-art"
import { SectionHeading } from "@/components/section-heading"

type Phase = { name: string; role: string; output: string }

const groups: { title: string; icon: PixelIconName; phases: Phase[] }[] = [
  {
    title: "Decide what to build",
    icon: "document",
    phases: [
      { name: "spec", role: "PM", output: "docs/spec.md" },
      { name: "architecture", role: "Architect", output: "docs/architecture.md" },
    ],
  },
  {
    title: "Decide how it looks",
    icon: "pencil",
    phases: [
      { name: "concepts", role: "Illustrator", output: "design/concepts/" },
      { name: "branding", role: "Illustrator", output: "design/branding/" },
      { name: "design", role: "Designer", output: "design/tokens.css" },
      { name: "marketing", role: "Marketer", output: "marketing/" },
    ],
  },
  {
    title: "Build and ship",
    icon: "package",
    phases: [
      { name: "plan", role: "Planner", output: "tasks.json" },
      { name: "build", role: "Worker, Reviewer", output: "one commit per task" },
      { name: "qa", role: "QA", output: "report.json" },
      { name: "deploy", role: "Orchestrator", output: "live preview URL" },
    ],
  },
]

const firstPhaseNumbers = groups.map((_, index) => groups.slice(0, index).reduce((total, group) => total + group.phases.length, 1))

export function PipelineSection() {
  return (
    <section id="pipeline" className="relative scroll-mt-8 overflow-hidden py-24 sm:py-32">
      <PixelCluster className="top-10 right-6 hidden sm:block" />
      <div className="relative mx-auto flex max-w-6xl flex-col gap-16 px-4 sm:px-6">
        <SectionHeading eyebrow="How it works" title="Ten phases, one brief.">
          Every phase has one role and writes real files to the project repository. You can read, edit or approve each one before the next phase
          starts.
        </SectionHeading>

        <ol className="grid gap-12 lg:grid-cols-3 lg:gap-0 lg:divide-x lg:divide-border">
          {groups.map((group, groupIndex) => (
            <li key={group.title} className="flex flex-col gap-6 lg:px-8 lg:first:pl-0 lg:last:pr-0">
              <div className="flex flex-col gap-4 border-b border-border pb-6">
                <span className="grid size-16 place-items-center rounded-full bg-accent">
                  <PixelIcon name={group.icon} size={34} />
                </span>
                <h3 className="font-mono text-xl font-bold tracking-tight">{group.title}</h3>
              </div>
              <ol className="flex flex-col">
                {group.phases.map((phase, phaseIndex) => {
                  const phaseNumber = firstPhaseNumbers[groupIndex] + phaseIndex
                  return (
                    <li key={phase.name} className="grid grid-cols-[4.25rem_1fr] items-center border-b border-border py-4 last:border-b-0">
                      <span className="font-mono text-[2.6rem] leading-none font-bold text-primary tabular-nums">{String(phaseNumber).padStart(2, "0")}</span>
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="font-mono text-lg font-bold">{phase.name}</span>
                          <span className="text-sm text-muted-foreground">{phase.role}</span>
                        </div>
                        <code className="font-mono text-[13px] text-accent-foreground">{phase.output}</code>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </li>
          ))}
        </ol>

        <div className="flex items-center gap-5 rounded-2xl border border-primary/25 bg-accent/60 px-5 py-5 sm:px-7">
          <span className="grid size-12 shrink-0 place-items-center rounded-full bg-card text-primary shadow-sm">
            <RefreshCw size={22} />
          </span>
          <div className="flex flex-col gap-1 border-border sm:border-l sm:pl-6">
            <strong className="text-lg font-semibold text-accent-foreground">After deploy, it keeps going.</strong>
            <p className="leading-relaxed text-muted-foreground">
              The evaluator scores the live app against your brief from 0 to 100 and builds what is missing, until it reaches your target score.
              Operate agents watch the live app and write findings for you to approve.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
