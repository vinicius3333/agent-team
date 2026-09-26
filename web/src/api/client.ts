import type { Defaults, GitIdentity, Finding, FindingStatus, InsightAgent, NewBacklogItem, SprintSnapshot, OperateSnapshot, LeadActionState, LeadSettings, NotificationStatus, NotificationTestResult, RoleCandidate, Incident, IncidentDetail, ImportProjectRequest, ConceptsView, NewProjectRequest, PlanningPhase, ProjectDetail, ProjectSummary, QaRound, StackTemplate, DesignStyleSummary } from "@/api/types"

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

  gitIdentity: () => getJson<GitIdentity | null>("/api/git-identity"),
  saveGitIdentity: (identity: GitIdentity) => post<GitIdentity>("/api/git-identity", identity),
  defaults: () => getJson<Defaults>("/api/defaults"),
  templates: () => getJson<StackTemplate[]>("/api/templates"),
  designStyles: () => getJson<DesignStyleSummary[]>("/api/design-styles"),
  projects: () => getJson<ProjectSummary[]>("/api/projects"),
  project: (name: string) => getJson<ProjectDetail>(projectPath(name)),
  markdownFiles: (name: string) => getJson<string[]>(`${projectPath(name)}/markdown`),
  branding: (name: string) => getJson<string[]>(`${projectPath(name)}/branding`),
  concepts: (name: string) => getJson<ConceptsView>(`${projectPath(name)}/concepts`),
  qa: (name: string) => getJson<QaRound[]>(`${projectPath(name)}/qa`),
  file: (name: string, path: string) => getText(`${projectPath(name)}/file?path=${encodeURIComponent(path)}`),
  incidents: () => getJson<Incident[]>("/api/incidents"),
  incident: (project: string, id: string) => getJson<IncidentDetail>(`/api/incidents/${encodeURIComponent(project)}/${encodeURIComponent(id)}`),
  notifications: () => getJson<NotificationStatus>("/api/notifications"),
  transcript: (name: string, file: string) => getText(`${projectPath(name)}/transcript/${encodeURIComponent(file)}`),
  operate: (name: string) => getJson<OperateSnapshot>(`${projectPath(name)}/operate`),
  findings: (name: string, status: FindingStatus | "all" = "open") => getJson<Finding[]>(`${projectPath(name)}/findings?status=${status}`),
  sprints: (name: string) => getJson<SprintSnapshot>(`${projectPath(name)}/sprints`),

  createProject: (body: NewProjectRequest) => post<{ name: string }>("/api/projects", body),
  importProject: (body: ImportProjectRequest) => post<{ name: string }>("/api/projects/import", body),
  startCleanup: (name: string) => post<{ id: string; branch: string; started: boolean }>(`${projectPath(name)}/cleanup/start`, {}),
  dismissCleanup: (name: string) => post<{ dismissed: boolean }>(`${projectPath(name)}/cleanup/dismiss`, {}),
  run: (name: string) => post<{ started: boolean }>(`${projectPath(name)}/run`, {}),
  approve: (name: string, phase: string, choice?: string) => post<{ started: boolean }>(`${projectPath(name)}/approve`, choice ? { phase, choice } : { phase }),
  feedback: (name: string, phase: string, message: string) => post<{ started: boolean }>(`${projectPath(name)}/feedback`, { phase, message }),
  approveTaskBudget: (name: string, taskId: string) => post<{ budgetUsd: number; started: boolean }>(`${projectPath(name)}/approve-task-budget`, { taskId }),
  retry: (name: string, taskId: string) => post<{ started: boolean }>(`${projectPath(name)}/retry`, { taskId }),
  approveSuggestion: (name: string, taskId: string) => post<{ paths: string[]; started: boolean }>(`${projectPath(name)}/approve-suggestion`, { taskId }),
  setAutoApproveScope: (name: string, enabled: boolean) => post<{ enabled: boolean }>(`${projectPath(name)}/auto-approve-scope`, { enabled }),
  setGates: (name: string, gates: PlanningPhase[]) => post<{ saved: boolean }>(`${projectPath(name)}/gates`, { gates }),
  dropTask: (name: string, taskId: string) => post<{ started: boolean }>(`${projectPath(name)}/drop-task`, { taskId }),
  saveRoles: (name: string, roles: Record<string, RoleCandidate>) => post<{ saved: boolean }>(`${projectPath(name)}/roles`, { roles }),
  chat: (name: string, message: string, attachments: string[] = []) => post<{ accepted: boolean }>(`${projectPath(name)}/chat`, { message, attachments }),
  chatSession: (name: string, session?: number) => post<{ session: number }>(`${projectPath(name)}/chat-session`, session === undefined ? {} : { session }),
  chatStop: (name: string) => post<{ stopped: boolean }>(`${projectPath(name)}/chat-stop`, {}),
  chatAction: (name: string, messageId: number, index: number, state: Exclude<LeadActionState, "proposed">) =>
    post<{ saved: boolean; note?: string; started?: boolean }>(`${projectPath(name)}/chat-action`, { messageId, index, state }),
  uploadChatImage: async (name: string, file: File) => {
    const response = await fetch(`${projectPath(name)}/chat-upload`, { method: "POST", headers: { "content-type": file.type, "x-agent-team": "1" }, body: file })
    if (!response.ok) throw await errorFrom(response)
    return (await response.json()) as { file: string }
  },
  files: (name: string) => getJson<string[]>(`${projectPath(name)}/files`),
  saveLeadSettings: (name: string, settings: LeadSettings) => post<{ saved: boolean }>(`${projectPath(name)}/lead-settings`, settings),
  testNotifications: (channel?: string) => post<NotificationTestResult[]>("/api/notifications/test", channel ? { channel } : {}),
  requestChange: (name: string, request: string) => post<{ id: string; branch: string; started: boolean }>(`${projectPath(name)}/changes`, { request }),
  abandonChange: (name: string, id: string) => post<{ abandoned: boolean }>(`${projectPath(name)}/changes/${encodeURIComponent(id)}/abandon`, {}),
  approveChangeMerge: (name: string, id: string) => post<{ started: boolean }>(`${projectPath(name)}/changes/${encodeURIComponent(id)}/merge`, {}),
  approveFinding: (name: string, id: number) => post<{ changeId: string; branch: string; started: boolean }>(`${projectPath(name)}/findings/${id}/approve`, {}),
  dismissFinding: (name: string, id: number) => post<{ dismissed: boolean }>(`${projectPath(name)}/findings/${id}/dismiss`, {}),
  addBacklogItem: (name: string, item: NewBacklogItem) => post<Finding>(`${projectPath(name)}/findings`, item),
  startSprint: (name: string) => post<{ started: boolean }>(`${projectPath(name)}/sprints/start`, {}),
  runInsight: (name: string, agent: InsightAgent) => post<{ accepted: boolean }>(`${projectPath(name)}/operate/run`, { agent }),
  // Without runUsd the server adds 50%.
  raiseBudget: (name: string, runUsd?: number) => post<{ runUsd: number; started: boolean }>(`${projectPath(name)}/raise-budget`, runUsd === undefined ? {} : { runUsd }),
}

export const urls = {
  stream: (name: string) => `/api/stream/${encodeURIComponent(name)}`,
  brandingImage: (name: string, file: string) => `${projectPath(name)}/branding/${encodeURIComponent(file)}`,
  conceptImage: (name: string, id: string, file: string) => `${projectPath(name)}/concepts/${encodeURIComponent(id)}/${encodeURIComponent(file)}`,
  qaFile: (name: string, round: number, file: string) => `${projectPath(name)}/qa/${round}/${encodeURIComponent(file)}`,
  raw: (name: string, path: string) => `${projectPath(name)}/raw?path=${encodeURIComponent(path)}`,
  file: (name: string, path: string) => `${projectPath(name)}/file?path=${encodeURIComponent(path)}`,
  chatUpload: (name: string, file: string) => `${projectPath(name)}/chat-upload/${encodeURIComponent(file)}`,
}
