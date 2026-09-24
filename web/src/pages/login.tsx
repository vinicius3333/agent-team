import { useState, type FormEvent } from "react"
import { LockKeyhole } from "lucide-react"
import { useAuth } from "@/api/auth-context"
import { api, ApiError } from "@/api/client"
import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

function loginError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return "Wrong password."
  if (error instanceof ApiError && error.status === 429) {
    const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60))
    return `Too many tries. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`
  }
  return error instanceof Error ? error.message : "The login failed."
}

export function LoginPage() {
  const { refresh } = useAuth()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await api.login(password)
      await refresh()
    } catch (reason) {
      setError(loginError(reason))
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md gap-6 py-8">
        <CardHeader className="gap-6 px-8">
          <div className="flex justify-center">
            <Logo className="[&_img]:size-9 [&_span]:text-2xl" />
          </div>
          <div className="grid gap-2">
            <CardTitle className="text-2xl">Log in</CardTitle>
            <CardDescription>Enter the dashboard password.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-8">
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={error !== null}
                  aria-describedby={error ? "password-error" : undefined}
                  className="h-11 pl-9"
                />
              </div>
              {error && (
                <p id="password-error" role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
            <Button type="submit" size="lg" className="h-11 w-full" disabled={submitting || !password}>
              {submitting ? "Logging in…" : "Log in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
