import { useCallback, useEffect, useRef, useState } from "react"
import { api, urls } from "@/api/client"
import type { ProjectDetail, ProjectSummary } from "@/api/types"

export type StreamState = "connecting" | "open" | "retrying"

export function useProjectStream(name: string) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [state, setState] = useState<StreamState>("connecting")
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    setDetail(null)
    setMissing(false)
    setState("connecting")
    const source = new EventSource(urls.stream(name))
    source.onopen = () => setState("open")
    source.onmessage = (event: MessageEvent<string>) => {
      setState("open")
      setDetail(JSON.parse(event.data) as ProjectDetail)
    }
    source.onerror = () => {
      setState("retrying")
      api
        .session()
        .then((session) => {
          if (!session.authenticated) source.close()
        })
        .catch(() => {})
      api.project(name).catch((error: { status?: number }) => {
        if (error.status === 404) {
          setMissing(true)
          source.close()
        }
      })
    }
    return () => source.close()
  }, [name])

  return { detail, state, missing }
}

export function useProjects(intervalMs = 5000) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [online, setOnline] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setProjects(await api.projects())
      setOnline(true)
    } catch {
      setOnline(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, intervalMs)
    return () => clearInterval(timer)
  }, [refresh, intervalMs])

  return { projects, online, refresh }
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loadRef
      .current()
      .then((result) => {
        if (!cancelled) setValue(result)
      })
      .catch((reason: Error) => {
        if (!cancelled) {
          setValue(null)
          setError(reason)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { value, error, loading }
}
