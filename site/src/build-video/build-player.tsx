import { Player, type PlayerRef } from "@remotion/player"
import { Pause, Play, RotateCcw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { BuildVideo, compositionHeight, compositionWidth } from "@/build-video/build-video"
import { activeRolesAt, durationInFrames, fps, stageById, type RoleName } from "@/build-video/stages"

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
const finishedFrame = stageById("deploy").from + 70
// ?frame=N opens the animation paused on one frame, for reviewing each step.
const requestedFrame = new URLSearchParams(window.location.search).get("frame")
const pausedFrame = requestedFrame === null ? (prefersReducedMotion ? finishedFrame : null) : Math.min(Number(requestedFrame), durationInFrames - 1)

export function BuildPlayer({ onActiveRolesChange }: { onActiveRolesChange: (roles: RoleName[]) => void }) {
  const playerRef = useRef<PlayerRef>(null)
  const [playing, setPlaying] = useState(pausedFrame === null)

  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    let lastKey = ""
    const publishRoles = () => {
      const roles = activeRolesAt(player.getCurrentFrame())
      const key = roles.join()
      if (key === lastKey) return
      lastKey = key
      onActiveRolesChange(roles)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    publishRoles()
    player.addEventListener("frameupdate", publishRoles)
    player.addEventListener("play", onPlay)
    player.addEventListener("pause", onPause)
    return () => {
      player.removeEventListener("frameupdate", publishRoles)
      player.removeEventListener("play", onPlay)
      player.removeEventListener("pause", onPause)
    }
  }, [onActiveRolesChange])

  return (
    <figure className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_60px_-30px_rgb(76_29_149/0.35)]">
      <Player
        ref={playerRef}
        component={BuildVideo}
        durationInFrames={durationInFrames}
        fps={fps}
        compositionWidth={compositionWidth}
        compositionHeight={compositionHeight}
        initialFrame={pausedFrame ?? 0}
        autoPlay={pausedFrame === null}
        loop
        clickToPlay={false}
        doubleClickToFullscreen={false}
        spaceKeyToPlayOrPause={false}
        acknowledgeRemotionLicense
        style={{ width: "100%" }}
      />
      <figcaption className="sr-only">
        Animation of an example run: the agents write the spec, the architecture, the brand and the design system, plan eight tasks, build and review
        each one, test the app and deploy it.
      </figcaption>
      <div className="absolute right-3 bottom-3 flex gap-1.5">
        <button
          type="button"
          onClick={() => playerRef.current?.seekTo(0)}
          className="grid size-8 place-items-center rounded-lg border border-border bg-card/90 text-muted-foreground hover:text-foreground"
          aria-label="Restart the animation"
        >
          <RotateCcw size={15} />
        </button>
        <button
          type="button"
          onClick={() => playerRef.current?.toggle()}
          className="grid size-8 place-items-center rounded-lg border border-border bg-card/90 text-muted-foreground hover:text-foreground"
          aria-label={playing ? "Pause the animation" : "Play the animation"}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
      </div>
    </figure>
  )
}
