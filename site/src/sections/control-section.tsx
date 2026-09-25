import { useState } from "react"
import { CodeBlock } from "@/components/code-block"
import { PixelCluster, PixelIcon, type PixelIconName } from "@/components/pixel-art"
import { SectionHeading } from "@/components/section-heading"

const gatePhases = ["spec", "architecture", "concepts", "branding", "design", "marketing", "plan"]

const controls: { icon: PixelIconName; title: string; text: string }[] = [
  {
    icon: "budget",
    title: "A budget per task and per run",
    text: "The run stops when the reported agent cost reaches budget.runUsd. Raise budget and resume adds 50%.",
  },
  {
    icon: "lock",
    title: "Blocked tasks ask first",
    text: "A worker that needs files outside its task says why. Approve and retry in one click, or let autoApproveScope handle it.",
  },
  {
    icon: "chat",
    title: "A lead you can ask",
    text: "The Lead tab answers questions about the run and suggests actions. It never changes the project on its own.",
  },
]

export function ControlSection() {
  const [gates, setGates] = useState(["spec", "architecture", "concepts"])

  const toggle = (phase: string) =>
    setGates((current) => (current.includes(phase) ? current.filter((gate) => gate !== phase) : gatePhases.filter((item) => item === phase || current.includes(item))))

  const yaml = `autonomy:\n  gates: [${gates.join(", ")}]\n  autoApproveScope: false\nbudget:\n  perTaskUsd: 2\n  runUsd: 150`

  return (
    <section id="control" className="ink-band relative scroll-mt-8 overflow-hidden py-24 sm:py-32">
      <PixelCluster className="top-12 right-6 hidden sm:block" />
      <PixelCluster className="bottom-10 left-4 hidden sm:block" flip />
      <div className="relative mx-auto flex max-w-6xl flex-col gap-16 px-4 sm:px-6">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-16">
          <div className="flex flex-col gap-8">
            <SectionHeading eyebrow="You stay in control" title="Autonomous where you want it.">
              Choose the phases where the run stops for you. At each gate you see the output, then approve it or request changes with notes.
            </SectionHeading>
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-3 text-sm text-muted-foreground">Stop for my review after:</legend>
              <div className="flex flex-wrap gap-2.5">
                {gatePhases.map((phase) => {
                  const checked = gates.includes(phase)
                  return (
                    <label
                      key={phase}
                      className={`cursor-pointer rounded-full border px-4 py-2 font-mono text-sm transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring ${
                        checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50 text-foreground hover:border-foreground"
                      }`}
                    >
                      <input id={`gate-${phase}`} type="checkbox" className="sr-only" checked={checked} onChange={() => toggle(phase)} />
                      {phase}
                    </label>
                  )
                })}
              </div>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {gates.length === 0
                  ? "No gates: the run goes from brief to live app without stopping."
                  : `The run pauses ${gates.length} time${gates.length === 1 ? "" : "s"} for your approval.`}
              </p>
            </fieldset>
          </div>
          <CodeBlock title="pipeline.yaml" copyText={yaml} code={yaml} language="yaml" lineNumbers />
        </div>

        <ul className="grid gap-10 border-t border-border pt-12 md:grid-cols-3 md:gap-0 md:divide-x md:divide-border">
          {controls.map((control) => (
            <li key={control.title} className="flex flex-col gap-4 md:px-8 md:first:pl-0 md:last:pr-0">
              <span className="grid size-14 place-items-center rounded-full bg-accent">
                <PixelIcon name={control.icon} size={30} />
              </span>
              <h3 className="font-mono text-lg font-bold">{control.title}</h3>
              <p className="leading-relaxed text-muted-foreground">{control.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
