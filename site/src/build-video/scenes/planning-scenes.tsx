import { interpolate, useCurrentFrame } from "remotion"
import { FileChip, Rise } from "@/build-video/motion"

const userStories = ["US-01 Post a joke", "US-02 Vote a joke up", "US-03 See the daily top 10"]

export function SpecScene() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-1 flex-col justify-center gap-2 rounded-xl border border-border bg-card p-7 font-mono text-[18px] leading-relaxed">
        <Rise className="text-[22px] font-bold">
          <span className="text-primary"># </span>Dad Jokes
        </Rise>
                <Rise delay={6} className="mt-3 font-bold">
          <span className="text-primary">## </span>User stories
        </Rise>
        {userStories.map((story, index) => (
          <Rise key={story} delay={10 + index * 5} className="flex items-center gap-3">
            <span className="text-primary">-</span>
            {story}
          </Rise>
        ))}
      </div>
      <FileChip path="docs/spec.md" delay={26} />
    </div>
  )
}

const layers = [
  { name: "Web UI", detail: "React" },
  { name: "API", detail: "/api/jokes" },
  { name: "Database", detail: "SQLite" },
]

export function ArchitectureScene() {
  const frame = useCurrentFrame()
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-1 items-center justify-between rounded-xl border border-border bg-card px-6">
        {layers.map((layer, index) => {
          const lineProgress = interpolate(frame, [10 + index * 10, 20 + index * 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
          return (
            <div key={layer.name} className="flex items-center">
              <Rise delay={index * 10} className="w-[140px] rounded-lg border-2 border-primary/40 bg-accent px-4 py-5 text-center">
                <div className="text-[19px] font-semibold">{layer.name}</div>
                <div className="font-mono text-[14px] text-accent-foreground">{layer.detail}</div>
              </Rise>
              {index < layers.length - 1 && (
                <div className="mx-2 h-[3px] w-[28px] origin-left bg-primary" style={{ transform: `scaleX(${lineProgress})` }} />
              )}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <FileChip path="docs/architecture.md" delay={24} />
        <FileChip path="contracts/openapi.yaml" delay={28} />
      </div>
    </div>
  )
}
