import { Rocket } from "lucide-react"
import { Button } from "@/components/ui/button"

export function App() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col items-start justify-center gap-4 px-4">
      <h1 className="text-3xl font-semibold tracking-tight">App</h1>
      <p className="text-muted-foreground">The scaffold works. Features go in src/features.</p>
      <Button>
        <Rocket /> Get started
      </Button>
    </main>
  )
}
