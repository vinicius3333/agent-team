import { Container, GitBranch, GitPullRequest, Hexagon, SquareTerminal, type LucideIcon } from "lucide-react"
import { CodeBlock } from "@/components/code-block"
import { PixelCluster } from "@/components/pixel-art"
import { SectionHeading } from "@/components/section-heading"
import { repositoryUrl } from "@/components/site-header"

// The image's entrypoint loads ~/.config/agent-team/doctor.env, so the token file must exist before docker run.
// Port 4400 is published on the host's loopback only, so the dashboard runs without a login, as it does with node.
const dockerCommand = [
  "mkdir -p ~/.config/agent-team",
  'echo "CLAUDE_CODE_OAUTH_TOKEN=..." > ~/.config/agent-team/doctor.env',
  "docker run -d --name agent-team -p 127.0.0.1:4400:4400 \\",
  "  -v agent-team-home:/home/opc \\",
  "  -v ~/.config/agent-team:/home/opc/.config/agent-team:ro \\",
  "  ghcr.io/vinicius3333/agent-team:latest \\",
  "  node src/cli.ts ui /home/opc/agent-team-runs --port 4400 --host 0.0.0.0 --insecure-no-auth",
].join("\n")

const steps = [
  {
    title: "Run the dashboard with Docker",
    command: dockerCommand,
    note: "Get the token from claude setup-token. Then skip to the last step, or install from source below.",
  },
  { title: "Or get the code and build the dashboard", command: `git clone ${repositoryUrl}.git\ncd agent-team\nnpm install\nnpm run build:ui` },
  {
    title: "Start the dashboard",
    command: "CLAUDE_CODE_OAUTH_TOKEN=... node src/cli.ts ui ~/projects --port 4400",
    note: "Get the token from claude setup-token.",
  },
  {
    title: "Open it and write your brief",
    command: "http://127.0.0.1:4400",
    window: "Browser",
    note: "Click New project, describe your idea in plain words, choose your gates, and start the build.",
  },
]

const requirements: { icon: LucideIcon; label: string }[] = [
  { icon: Hexagon, label: "Node.js 22.18+" },
  { icon: GitBranch, label: "git" },
  { icon: SquareTerminal, label: "Claude Code CLI, logged in" },
  { icon: SquareTerminal, label: "Codex CLI, logged in" },
  { icon: Container, label: "Docker" },
  { icon: GitPullRequest, label: "gh CLI, for GitHub (optional)" },
]

export function InstallSection() {
  return (
    <section id="install" className="relative scroll-mt-8 overflow-hidden border-t border-border py-24 sm:py-32">
      <PixelCluster className="top-12 right-6 hidden sm:block" />
      <div className="relative mx-auto flex max-w-6xl flex-col gap-14 px-4 sm:px-6">
        <SectionHeading eyebrow="Quick start" title="Your first build in one command.">
          Most work happens in the dashboard. Everything it does also works from the command line, for scripts.
        </SectionHeading>
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-16">
          <ol className="flex flex-col">
            {steps.map((step, index) => (
              <li key={step.title} className="relative grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 pb-10 last:pb-0">
                {index < steps.length - 1 && (
                  <span className="absolute top-11 bottom-1 left-[19px] border-l-2 border-dashed border-primary/30" aria-hidden="true" />
                )}
                <span className="grid size-10 place-items-center rounded-xl bg-primary font-mono text-lg font-bold text-primary-foreground">{index + 1}</span>
                <div className="flex flex-col gap-3">
                  <h3 className="flex min-h-10 items-center text-lg font-semibold">{step.title}</h3>
                  <CodeBlock title={step.window ?? "Terminal"} copyText={step.command} code={step.command} />
                  {step.note && <p className="text-sm text-muted-foreground">{step.note}</p>}
                </div>
              </li>
            ))}
          </ol>
          <aside className="flex h-fit flex-col gap-5 rounded-2xl border border-border bg-card p-6 lg:sticky lg:top-8">
            <h3 className="font-mono text-xs font-medium tracking-[0.14em] text-primary uppercase">Requirements</h3>
            <ul className="flex flex-col gap-4">
              {requirements.map((requirement) => {
                const Icon = requirement.icon
                return (
                  <li key={requirement.label} className="flex items-center gap-3">
                    <Icon size={20} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                    {requirement.label}
                  </li>
                )
              })}
            </ul>
          </aside>
        </div>
      </div>
    </section>
  )
}
