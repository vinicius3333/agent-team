import type { ComponentType } from "react"
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion"
import { SceneTransition } from "@/build-video/motion"
import { ArchitectureScene, SpecScene } from "@/build-video/scenes/planning-scenes"
import { BrandingScene, DesignScene } from "@/build-video/scenes/design-scenes"
import { BuildScene, PlanScene } from "@/build-video/scenes/task-scenes"
import { DeployScene, QaScene } from "@/build-video/scenes/ship-scenes"
import { durationInFrames, stageAt, stages, type Stage } from "@/build-video/stages"

export const compositionWidth = 640
export const compositionHeight = 600

const scenes: Record<Stage["id"], ComponentType> = {
  spec: SpecScene,
  architecture: ArchitectureScene,
  branding: BrandingScene,
  design: DesignScene,
  plan: PlanScene,
  build: BuildScene,
  qa: QaScene,
  deploy: DeployScene,
}

function StepProgress({ frame }: { frame: number }) {
  return (
    <div className="flex gap-1.5">
      {stages.map((stage) => {
        const fill = interpolate(frame, [stage.from, stage.from + stage.durationInFrames], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
        return (
          <div key={stage.id} className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${fill}%` }} />
          </div>
        )
      })}
    </div>
  )
}

function formatElapsed(frame: number) {
  // The loop lasts about 15 seconds; the clock shows a plausible real run of about 40 minutes.
  const minutes = interpolate(frame, [0, durationInFrames], [0, 41])
  return `${Math.floor(minutes)}m ${String(Math.floor((minutes % 1) * 60)).padStart(2, "0")}s`
}

export function BuildVideo() {
  const frame = useCurrentFrame()
  const stage = stageAt(frame)
  const stepNumber = stages.indexOf(stage) + 1
  const cost = interpolate(frame, [0, stages.at(-1)!.from], [0, 4.12], { extrapolateRight: "clamp" })

  return (
    <AbsoluteFill className="flex flex-col gap-5 bg-card p-9 font-sans text-foreground">
      <div className="flex items-center justify-between font-mono text-[14px] text-muted-foreground">
        <span>Example run · dad-jokes</span>
        <span>
          Step {stepNumber} of {stages.length}
        </span>
      </div>
      <StepProgress frame={frame} />
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[27px] font-bold tracking-tight">{stage.title}</div>
          <div className="font-mono text-[15px] text-muted-foreground">{stage.output}</div>
        </div>
        {stage.role && (
          <span className="rounded-full bg-accent px-3.5 py-1 text-[15px] font-semibold text-accent-foreground">{stage.role}</span>
        )}
      </div>
      <div className="relative flex-1">
        {stages.map((item) => {
          const Scene = scenes[item.id]
          return (
            <Sequence key={item.id} from={item.from} durationInFrames={item.durationInFrames} layout="none">
              <SceneTransition durationInFrames={item.durationInFrames}>
                <Scene />
              </SceneTransition>
            </Sequence>
          )
        })}
      </div>
      <div className="flex gap-6 border-t border-border pt-3 font-mono text-[14px] text-muted-foreground">
        <span>Elapsed {formatElapsed(frame)}</span>
        <span>Cost ${cost.toFixed(2)}</span>
      </div>
    </AbsoluteFill>
  )
}
