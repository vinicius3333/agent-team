import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/api/client"
import type { Finding, FindingStatus, OperateSnapshot } from "@/api/types"
import { useProjectView } from "@/components/project/context"

const pollMs = 30_000

// Loads on mount, every 30 s while the tab is visible, when it becomes visible again, and when the project stream reports a new event.
function usePolled<T>(load: () => Promise<T>, key: string) {
  const { detail } = useProjectView()
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const lastEvent = detail.events.at(-1)?.id ?? 0

  const refresh = useCallback(async () => {
    try {
      setValue(await loadRef.current())
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error(String(reason)))
    }
  }, [])

  useEffect(() => {
    setValue(null)
  }, [key])

  useEffect(() => {
    void refresh()
  }, [refresh, key, lastEvent])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, pollMs)
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh, key])

  return { value, error, refresh }
}

export function useOperateSnapshot() {
  const { name } = useProjectView()
  const { value, error, refresh } = usePolled<OperateSnapshot>(() => api.operate(name), name)
  return { snapshot: value, error, refresh }
}

export function useFindings(status: FindingStatus | "all" = "open") {
  const { name } = useProjectView()
  const { value, error, refresh } = usePolled<Finding[]>(() => api.findings(name, status), `${name}:${status}`)
  return { findings: value, error, refresh }
}
