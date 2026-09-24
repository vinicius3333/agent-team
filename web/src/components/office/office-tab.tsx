import { lazy, Suspense } from "react"
import { useSearchParams } from "react-router"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { OfficeScene } from "./office-scene"

const Office3D = lazy(() => import("./three/office-3d").then((module) => ({ default: module.Office3D })))

export function OfficeTab() {
  const [searchParams, setSearchParams] = useSearchParams()
  const view = searchParams.get("view") === "2d" ? "2d" : "3d"
  const select = (next: string) =>
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current)
        params.set("view", next)
        return params
      },
      { replace: true },
    )
  return (
    <div className="flex flex-col gap-3">
      <Tabs value={view} onValueChange={select}>
        <TabsList>
          <TabsTrigger value="3d">3D</TabsTrigger>
          <TabsTrigger value="2d">2D</TabsTrigger>
        </TabsList>
      </Tabs>
      {view === "3d" ? (
        <Suspense fallback={<Skeleton className="aspect-[16/10] w-full rounded-lg" />}>
          <Office3D />
        </Suspense>
      ) : (
        <OfficeScene />
      )}
    </div>
  )
}
