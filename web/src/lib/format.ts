export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—"
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export function formatClock(iso: string | number): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

export function formatDateTime(iso: string | number): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString()
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never"
  const diff = Date.now() - Date.parse(iso)
  if (Number.isNaN(diff)) return ""
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

export function formatCost(usd: number, digits = 2): string {
  return `$${usd.toFixed(digits)}`
}

export function formatProjectCost(usd: number, unreported: boolean): string {
  if (unreported && usd === 0) return "n/a"
  return `${formatCost(usd)}${unreported ? " + n/a" : ""}`
}

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export function humanize(status: string): string {
  return status.replaceAll("_", " ")
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 2 : 1)}M`
}
