import type { ReactNode } from "react"
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"

export function useEntrance(delayInFrames = 0) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return spring({ frame: frame - delayInFrames, fps, config: { damping: 16, stiffness: 140 } })
}

export function Rise({ delay = 0, distance = 14, children, className }: { delay?: number; distance?: number; children: ReactNode; className?: string }) {
  const progress = useEntrance(delay)
  return (
    <div className={className} style={{ opacity: progress, transform: `translateY(${(1 - progress) * distance}px)` }}>
      {children}
    </div>
  )
}

export function Pop({ delay = 0, children, className }: { delay?: number; children: ReactNode; className?: string }) {
  const progress = useEntrance(delay)
  return (
    <div className={className} style={{ opacity: Math.min(1, progress * 1.5), transform: `scale(${0.6 + progress * 0.4})` }}>
      {children}
    </div>
  )
}

const exitFrames = 8

export function SceneTransition({ durationInFrames, children }: { durationInFrames: number; children: ReactNode }) {
  const frame = useCurrentFrame()
  const progress = useEntrance()
  const exit = interpolate(frame, [durationInFrames - exitFrames, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <div
      className="absolute inset-0"
      style={{ opacity: Math.min(progress, exit), transform: `translateX(${(1 - progress) * 24 - (1 - exit) * 24}px)` }}
    >
      {children}
    </div>
  )
}

export function FileChip({ path, delay = 0 }: { path: string; delay?: number }) {
  return (
    <Rise delay={delay} distance={8}>
      <span className="inline-flex items-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1 font-mono text-[15px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-success" />
        {path}
      </span>
    </Rise>
  )
}
