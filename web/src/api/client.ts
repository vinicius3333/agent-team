import type { Defaults, LeadActionState, NotificationStatus, NotificationTestResult, RoleCandidate, Incident, IncidentDetail, NewProjectRequest, ProjectDetail, ProjectSummary, QaRound, StackTemplate } from "@/api/types"

export class ApiError extends Error {
  status: number
  retryAfterSeconds: number | null

  constructor(status: number, message: string, retryAfterSeconds: number | null = null) {
    super(message)
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export type AuthMode = "none" | "password" | "proxy" | "password+proxy"

export interface AuthSession {
  authenticated: boolean
  user: string | null
  source: "proxy" | "session" | null
  mode: AuthMode
}

export const unauthorizedEvent = "agent-team:unauthorized"

const projectPath = (name: string) => `/api/projects/${encodeURIComponent(name)}`

async function errorFrom(response: Response): Promise<ApiError> {
  let message = `The server answered ${response.status}.`
  try {
    const body: unknown = await response.json()
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") message = body.error
  } catch {
    // The body was not JSON; keep the generic message.
  }
  if (response.status === 401) window.dispatchEvent(new Event(unauthorizedEvent))
  const retryAfter = Number(response.headers.get("retry-after"))
  return new ApiError(response.status, message, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null)
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } })
  if (!response.ok) throw await errorFrom(response)
  return (await response.json()) as T
}

async function getText(path: string): Promise<string> {
  const response = await fetch(path)
  if (!response.ok) throw await errorFrom(response)
  return response.text()
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-team": "1" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await errorFrom(response)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  session: () => getJson<AuthSession>("/api/auth/session"),
  login: (password: string) => post<void>("/api/auth/login", { password }),
  logout: () => post<void>("/api/auth/logout", {}),

  defaults: () => getJson<Defaults>("/api/defaults"),
  templates: () => getJson<StackTemplate[]>("/api/templates"),
  projects: () => getJson<ProjectSummary[]>("/api/projects"),
  project: (name: string) => getJson<ProjectDetail>(projectPath(name)),
  markdownFiles: (name: string) => getJson<string[]>(`${projectPath(name)}/markdown`),
  branding: (name: string) => getJson<string[]>(`${projectPath(name)}/branding`),
  qa: (name: string) => getJson<QaRound[]>(`${projectPath(name)}/qa`),
  file: (name: string, path: string) => getText(`${projectPath(name)}/file?path=${encodeURIComponent(path)}`),
  incidents: () => getJson<Incident[]>("/api/incidents"),
  incident: (project: string, id: string) => getJson<IncidentDetail>(`/api/incidents/${encodeURIComponent(project)}/${encodeURIComponent(id)}`),
  notifications: () => getJson<NotificationStatus>("/api/notifications"),
  transcript: (name: string, file: string) => getText(`${projectPath(name)}/transcript/${encodeURIComponent(file)}`),

  createProject: (body: NewProjectRequest) => post<{ name: string }>("/api/projects", body),
  run: (name: string) => post<{ started: boolean }>(`${projectPath(name)}/run`, {}),
  approve: (name: string, phase: string) => post<{ started: boolean }>(`${projectPath(name)}/approve`, { phase }),
  feedback: (name: string, phase: string, message: string) => post<{ started: boolean }>(`${projectPath(name)}/feedback`, { phase, message }),
  retry: (name: string, taskId: string) => post<{ started: boolean }>(`${projectPath(name)}/retry`, { taskId }),
  saveRoles: (name: string, roles: Record<string, RoleCandidate>) => post<{ saved: boolean }>(`${projectPath(name)}/roles`, { roles }),
  chat: (name: string, message: string) => post<{ accepted: boolean }>(`${projectPath(name)}/chat`, { message }),
  chatAction: (name: string, messageId: number, index: number, state: Exclude<LeadActionState, "proposed">) =>
    post<{ saved: boolean }>(`${projectPath(name)}/chat-action`, { messageId, index, state }),
  testNotifications: (channel?: string) => post<NotificationTestResult[]>("/api/notifications/test", channel ? { channel } : {}),
  requestChange: (name: string, request: string) => post<{ id: string; branch: string; started: boolean }>(`${projectPath(name)}/changes`, { request }),
  abandonChange: (name: string, id: string) => post<{ abandoned: boolean }>(`${projectPath(name)}/changes/${encodeURIComponent(id)}/abandon`, {}),
  approveChangeMerge: (name: string, id: string) => post<{ started: boolean }>(`${projectPath(name)}/changes/${encodeURIComponent(id)}/merge`, {}),
  raiseBudget: (name: string) => post<{ runUsd: number; started: boolean }>(`${projectPath(name)}/raise-budget`, {}),
}

export const urls = {
  stream: (name: string) => `/api/stream/${encodeURIComponent(name)}`,
  brandingImage: (name: string, file: string) => `${projectPath(name)}/branding/${encodeURIComponent(file)}`,
  qaFile: (name: string, round: number, file: string) => `${projectPath(name)}/qa/${round}/${encodeURIComponent(file)}`,
  raw: (name: string, path: string) => `${projectPath(name)}/raw?path=${encodeURIComponent(path)}`,
  file: (name: string, path: string) => `${projectPath(name)}/file?path=${encodeURIComponent(path)}`,
}
