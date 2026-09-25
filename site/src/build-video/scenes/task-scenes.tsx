import { Check, Loader, Search } from "lucide-react"
import { useCurrentFrame } from "remotion"
import { FileChip, Rise } from "@/build-video/motion"
import { taskStatus, tasks, type TaskStatus } from "@/build-video/stages"

const commitHashes = ["a41f0c2", "9be21d7", "3c07e5a", "e1d9b40", "7f2a6c1", "b58e3d9", "04c7fa2", "d92b1e6"]

function StatusPill({ status, taskIndex }: { status: TaskStatus; taskIndex: number }) {
  if (status === "building") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-0.5 text-[13px] font-medium text-accent-foreground">
        <Loader size={13} /> Worker
      </span>
    )
  }
  if (status === "reviewing") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-0.5 text-[13px] font-medium text-warning">
        <Search size={13} /> Reviewer
      </span>
    )
  }
  if (status === "merged") {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[13px] text-success">
        <Check size={14} /> {commitHashes[taskIndex]}
      </span>
    )
  }
  return <span className="text-[13px] text-muted-foreground">To do</span>
}

function TaskList({ statusOf, animateIn }: { statusOf: (index: number) => TaskStatus; animateIn: boolean }) {
  return (
    <div className="grid flex-1 grid-cols-1 content-center rounded-xl border border-border bg-card px-6 py-2">
      {tasks.map((task, index) => {
        const status = statusOf(index)
        const row = (
          <div
            className={`flex h-[54px] items-center justify-between border-b border-border text-[18px] last:border-b-0 ${status === "building" || status === "reviewing" ? "font-semibold" : ""}`}
          >
            <span className="flex items-center gap-3">
              <span className="font-mono text-[13px] text-muted-foreground">T{String(index + 1).padStart(2, "0")}</span>
              <span className={status === "merged" ? "text-muted-foreground" : ""}>{task}</span>
            </span>
            <StatusPill status={status} taskIndex={index} />
          </div>
        )
        return animateIn ? (
          <Rise key={task} delay={index * 4} distance={10}>
            {row}
          </Rise>
        ) : (
          <div key={task}>{row}</div>
        )
      })}
    </div>
  )
}

export function PlanScene() {
  return (
    <div className="flex h-full flex-col gap-4">
      <TaskList statusOf={() => "todo"} animateIn />
      <FileChip path="tasks.json" delay={26} />
    </div>
  )
}

export function BuildScene() {
  const frame = useCurrentFrame()
  const merged = tasks.filter((_, index) => taskStatus(index, frame) === "merged").length
  return (
    <div className="flex h-full flex-col gap-4">
      <TaskList statusOf={(index) => taskStatus(index, frame)} animateIn={false} />
      <div className="flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-success" style={{ width: `${(merged / tasks.length) * 100}%` }} />
        </div>
        <span className="font-mono text-[15px] text-muted-foreground">
          {merged}/{tasks.length} merged
        </span>
      </div>
    </div>
  )
}
