import { Suspense, useMemo, useRef, useState, type ComponentRef } from "react"
import { Canvas } from "@react-three/fiber"
import { ContactShadows, OrbitControls } from "@react-three/drei"
import { RotateCcw, SunMoon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme } from "@/hooks/use-theme"
import type { SceneTime } from "./day-cycle"
import { Agents } from "./agents"
import { Decor } from "./decor"
import { Workstations } from "./workstations"
import { palettes } from "./layout"
import { Lighting, Sky, WallClock } from "./sky"
import { Walls } from "./walls"

// `?hour=19.5` starts the scene at a given time, handy for checking dusk and night.
function startingHours() {
  const requested = Number(new URLSearchParams(window.location.search).get("hour"))
  if (requested >= 0 && requested < 24 && new URLSearchParams(window.location.search).has("hour")) return requested
  const now = new Date()
  return now.getHours() + now.getMinutes() / 60
}

type LightingMode = "automatic" | "theme"

const lightingModes: { value: LightingMode; label: string; description: string }[] = [
  { value: "automatic", label: "Automatic", description: "Day and night cycle" },
  { value: "theme", label: "Follow theme", description: "Day in light theme, night in dark theme" },
]

const lightingStorageKey = "agent-team-office-lighting"

function storedLightingMode(): LightingMode {
  try {
    return localStorage.getItem(lightingStorageKey) === "theme" ? "theme" : "automatic"
  } catch {
    return "automatic"
  }
}

function runningClock(): SceneTime {
  return { startHours: startingHours(), running: true, since: performance.now() }
}

function LightingMenu({ mode, onChange }: { mode: LightingMode; onChange: (mode: LightingMode) => void }) {
  const current = lightingModes.find((entry) => entry.value === mode)!
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="bg-background/85 backdrop-blur-sm">
          <SunMoon /> {current.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Lighting</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={(value) => onChange(value as LightingMode)}>
          {lightingModes.map((entry) => (
            <DropdownMenuRadioItem key={entry.value} value={entry.value} className="flex-col items-start gap-0">
              <span>{entry.label}</span>
              <span className="text-xs text-muted-foreground">{entry.description}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Office3D() {
  const { resolved } = useTheme()
  const [mode, setMode] = useState(storedLightingMode)
  const [automatic, setAutomatic] = useState(runningClock)
  const themed = useMemo<SceneTime>(() => ({ startHours: resolved === "dark" ? 22 : 12, running: false, since: 0 }), [resolved])
  const time = mode === "theme" ? themed : automatic
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null)

  const changeMode = (next: LightingMode) => {
    setMode(next)
    if (next === "automatic") setAutomatic(runningClock())
    try {
      localStorage.setItem(lightingStorageKey, next)
    } catch {
      // Storage can be unavailable (private window); the choice then lasts for this visit only.
    }
  }

  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg bg-muted">
      <div className="absolute top-3 right-3 z-10 flex gap-2">
        <Button variant="outline" size="sm" className="bg-background/85 backdrop-blur-sm" onClick={() => controls.current?.reset()}>
          <RotateCcw /> Reset view
        </Button>
        <LightingMenu mode={mode} onChange={changeMode} />
      </div>
      <Canvas shadows orthographic flat dpr={[1, 2]} camera={{ position: [5, 11, 15], zoom: 52, near: 0.1, far: 100 }} gl={{ antialias: true }}>
        <Lighting time={time} />
        <Suspense fallback={null}>
          <Sky time={time} />
          <Walls palette={palettes.light} />
          <WallClock time={time} />
          <Workstations />
          <Agents />
          <Decor />
          <ContactShadows position={[0, 0.01, 0]} scale={20} blur={2.4} opacity={0.35} far={3} />
        </Suspense>
        <OrbitControls
          ref={controls}
          makeDefault
          target={[0, 0, -2.2]}
          enablePan={false}
          enableZoom
          zoomSpeed={0.8}
          zoomToCursor
          minZoom={40}
          maxZoom={220}
          minPolarAngle={0.35}
          maxPolarAngle={1.1}
          minAzimuthAngle={-0.6}
          maxAzimuthAngle={0.6}
        />
      </Canvas>
    </div>
  )
}
