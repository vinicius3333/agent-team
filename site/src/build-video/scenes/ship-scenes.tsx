import { ArrowUp, Check, Lock, Monitor, Smartphone, Smile } from "lucide-react"
import { interpolate, useCurrentFrame } from "remotion"
import { Pop, Rise } from "@/build-video/motion"

const screenshots = [
  { route: "/", device: "desktop" },
  { route: "/", device: "phone" },
  { route: "/top", device: "desktop" },
] as const

export function QaScene() {
  const frame = useCurrentFrame()
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="grid flex-1 grid-cols-3 items-center gap-6 rounded-xl border border-border bg-muted/60 px-7">
        {screenshots.map((shot, index) => {
          const checked = frame > 12 + index * 7
          return (
            <Pop key={`${shot.route}-${shot.device}`} delay={index * 4} className="flex flex-col items-center gap-2">
              <div className="relative grid h-[150px] w-full place-items-center rounded-lg border border-border bg-card text-muted-foreground">
                {shot.device === "desktop" ? <Monitor size={40} /> : <Smartphone size={40} />}
                {checked && (
                  <span className="absolute -top-2 -right-2 grid size-7 place-items-center rounded-full bg-success text-success-foreground">
                    <Check size={16} strokeWidth={3} />
                  </span>
                )}
              </div>
              <span className="font-mono text-[13px] text-muted-foreground">
                {shot.route} · {shot.device}
              </span>
            </Pop>
          )
        })}
      </div>
      <Rise delay={34} className="flex items-center gap-2 text-[16px]">
        <span className="rounded-full bg-success px-3 py-1 text-[14px] font-semibold text-success-foreground">Pass</span>
        <span className="text-muted-foreground">Round 1 · 14 tests passed · 0 blockers</span>
      </Rise>
    </div>
  )
}

const jokes = [
  { question: "Why don't eggs tell jokes?", votes: 342 },
  { question: "I told my computer a joke…", votes: 287 },
  { question: "Why did the scarecrow win an award?", votes: 198 },
]

const previewUrl = "https://dad-jokes-orbit-lantern.trycloudflare.com"

export function DeployScene() {
  const frame = useCurrentFrame()
  const typedUrl = previewUrl.slice(0, Math.round(interpolate(frame, [2, 20], [0, previewUrl.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })))
  const voteProgress = interpolate(frame, [22, 55], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <Rise distance={30} className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg">
      <div className="flex items-center gap-2 border-b border-border bg-muted px-4 py-2.5">
        <Lock size={14} className="text-success" />
        <span className="truncate font-mono text-[14px] text-muted-foreground">{typedUrl}</span>
      </div>
      <div className="flex items-center justify-between px-5 pt-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Smile size={22} />
          </span>
          <span className="text-[21px] font-bold">Dad Jokes</span>
        </div>
        <Pop delay={24}>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-3 py-1 text-[13px] font-semibold text-success">
            <span className="size-2 rounded-full bg-success" /> Live · 5/5 tasks
          </span>
        </Pop>
      </div>
      <div className="flex flex-1 flex-col justify-center px-5">
        {jokes.map((joke, index) => (
          <Rise key={joke.question} delay={22 + index * 5} className="flex items-center justify-between border-b border-border py-4 last:border-b-0">
            <span className="flex items-center gap-3 text-[17px]">
              <span className="w-4 font-mono text-muted-foreground">{index + 1}</span>
              {joke.question}
            </span>
            <span className="inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 font-mono text-[14px] font-semibold text-accent-foreground">
              <ArrowUp size={14} />
              {Math.round(joke.votes * voteProgress)}
            </span>
          </Rise>
        ))}
      </div>
    </Rise>
  )
}
