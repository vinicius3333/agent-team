import posthog from "posthog-js"

const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com"

// Off unless the deploy sets VITE_POSTHOG_KEY, so local runs and tests send nothing.
export function initAnalytics(): void {
  if (!key) return
  posthog.init(key, { api_host: host, capture_pageview: "history_change", person_profiles: "identified_only" })
}

// Records one user action. Name events in snake_case, past tense (for example "joke_voted"), and list them in docs/analytics.md.
export function track(event: string, properties?: Record<string, unknown>): void {
  if (!key) return
  posthog.capture(event, properties)
}
