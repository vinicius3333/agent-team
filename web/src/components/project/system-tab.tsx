import { Box, GitBranch, GitCommit, HeartPulse } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatClock } from "@/lib/format"
import { useProjectView } from "./context"

const rowButton = "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"

export function runnerCooldown(cooldowns: { runner: string; until: number; reason: string }[], runner: string) {
  const cooldown = cooldowns.find((entry) => entry.runner === runner)
  return cooldown && cooldown.until > Date.now() ? cooldown : null
}

export function RunnerHealthCard() {
  const { detail, openPanel } = useProjectView()
  const runners = [...new Set(["claude", "codex", ...detail.attempts.map((attempt) => attempt.runner)])]
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HeartPulse className="size-5" aria-hidden="true" /> Runner health
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 sm:px-4">
        <ul>
          {runners.map((runner) => {
            const cooldown = runnerCooldown(detail.cooldowns, runner)
            return (
              <li key={runner}>
                <button type="button" className={rowButton} onClick={() => openPanel({ kind: "runner", id: runner })}>
                  <span className="font-mono">{runner}</span>
                  {cooldown ? (
                    <>
                      <StatusBadge status="cooling" label={cooldown.reason} />
                      <span className="ml-auto text-xs text-muted-foreground">until {formatClock(cooldown.until)}</span>
                    </>
                  ) : (
                    <StatusBadge status="healthy" label="healthy" className="ml-auto" />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

export function SystemTab() {
  const { detail, openPanel } = useProjectView()
  const extraWorktrees = Math.max(0, detail.worktrees.length - 1)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <RunnerHealthCard />
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Box className="size-5" aria-hidden="true" /> Agent containers
            </CardTitle>
            <CardAction className="text-sm text-muted-foreground">{detail.containers.length}</CardAction>
          </CardHeader>
          <CardContent className="px-3 sm:px-4">
            {detail.containers.length ? (
              <ul>
                {detail.containers.map((container) => (
                  <li key={container.name}>
                    <button type="button" className={rowButton} onClick={() => openPanel({ kind: "container", id: container.name })}>
                      <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
                      <span className="min-w-0 truncate font-mono text-xs">{container.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{container.runningFor}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 text-sm text-muted-foreground">No agent containers are running.</p>
            )}
          </CardContent>
        </Card>
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="size-5" aria-hidden="true" /> Worktrees
            </CardTitle>
            <CardAction className="text-sm text-muted-foreground">{extraWorktrees} besides main</CardAction>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 font-mono text-xs break-all text-muted-foreground">
              {detail.worktrees.map((worktree) => (
                <li key={worktree}>{worktree}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <Card className="h-fit gap-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitCommit className="size-5" aria-hidden="true" /> Git log
          </CardTitle>
          <CardAction className="text-sm text-muted-foreground">main, last 30</CardAction>
        </CardHeader>
        <CardContent>
          {detail.gitLog.length ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {detail.gitLog.map((line) => {
                const [hash, ...rest] = line.split(" ")
                return (
                  <li key={line} className="flex gap-2">
                    <span className="shrink-0 font-mono text-xs text-primary">{hash}</span>
                    <span className="min-w-0 break-words">{rest.join(" ")}</span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <EmptyState title="No commits yet" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
