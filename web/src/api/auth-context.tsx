import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { api, unauthorizedEvent, type AuthMode, type AuthSession } from "@/api/client"

const sessionRetryMs = 5000

export type AuthStatus = "loading" | "anonymous" | "authenticated"

interface AuthContextValue {
  status: AuthStatus
  user: string | null
  source: AuthSession["source"]
  mode: AuthMode
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null)
  const [unreachable, setUnreachable] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setSession(await api.session())
      setUnreachable(false)
    } catch {
      setUnreachable(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!unreachable) return
    const timer = setTimeout(() => void refresh(), sessionRetryMs)
    return () => clearTimeout(timer)
  }, [unreachable, refresh])

  useEffect(() => {
    const onUnauthorized = () => setSession((current) => (current ? { ...current, authenticated: false, user: null, source: null } : current))
    window.addEventListener(unauthorizedEvent, onUnauthorized)
    return () => window.removeEventListener(unauthorizedEvent, onUnauthorized)
  }, [])

  const status: AuthStatus = session === null ? "loading" : session.authenticated ? "authenticated" : "anonymous"
  const value = { status, user: session?.user ?? null, source: session?.source ?? null, mode: session?.mode ?? "none", refresh }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error("useAuth must be used inside AuthProvider")
  return value
}
