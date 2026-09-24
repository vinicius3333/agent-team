import type { Defaults, LeadActionState, LeadSettings, RoleCandidate, Incident, IncidentDetail, NewProjectRequest, ProjectDetail, ProjectSummary, QaRound } from "@/api/types"

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const projectPath = (name: string) => `/api/projects/${encodeURIComponent(name)}`

async function errorFrom(response: Response): Promise<ApiError> {
  let message = `The server answered ${response.status}.`
  try {
    const body: unknown = await response.json()
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") message = body.error
  } catch {
    // The body was not JSON; keep the generic message.
  }
  return new ApiError(response.status, message)
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
  return (await response.json()) as T
}

export const api = {
  defaults: () => getJson<Defaults>("/api/defaults"),
  projects: () => getJson<ProjectSummary[]>("/api/projects"),
  project: (name: string) => getJson<ProjectDetail>(projectPath(name)),
  markdownFiles: (name: string) => getJson<string[]>(`${projectPath(name)}/markdown`),
  branding: (name: string) => getJson<string[]>(`${projectPath(name)}/branding`),
  qa: (name: string) => getJson<QaRound[]>(`${projectPath(name)}/qa`),
  file: (name: string, path: string) => getText(`${projectPath(name)}/file?path=${encodeURIComponent(path)}`),
  incidents: () => getJson<Incident[]>("/api/incidents"),
  incident: (project: string, id: string) => getJson<IncidentDetail>(`/api/incidents/${encodeURIComponent(project)}/${encodeURIComponent(id)}`),
  transcript: (name: string, file: string) => getText(`${projectPath(name)}/transcript/${encodeURIComponent(file)}`),

  createProject: (body: NewProjectRequest) => post<{ name: string }>("/api/projects", body),
  run: (name: string) => post<{ started: boolean }>(`${projectPath(name)}/run`, {}),
  approve: (name: string, phase: string) => post<{ started: boolean }>(`${projectPath(name)}/approve`, { phase }),
  feedback: (name: string, phase: string, message: string) => post<{ started: boolean }>(`${projectPath(name)}/feedback`, { phase, message }),
  approveTaskBudget: (name: string, taskId: string) => post<{ budgetUsd: number; started: boolean }>(`${projectPath(name)}/approve-task-budget`, { taskId }),
  retry: (name: string, taskId: string) => post<{ started: boolean }>(`${projectPath(name)}/retry`, { taskId }),
  saveRoles: (name: string, roles: Record<string, RoleCandidate>) => post<{ saved: boolean }>(`${projectPath(name)}/roles`, { roles }),
  chat: (name: string, message: string, attachments: string[] = []) => post<{ accepted: boolean }>(`${projectPath(name)}/chat`, { message, attachments }),
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
  // Without runUsd the server adds 50%.
  raiseBudget: (name: string, runUsd?: number) => post<{ runUsd: number; started: boolean }>(`${projectPath(name)}/raise-budget`, runUsd === undefined ? {} : { runUsd }),
}

export const urls = {
  stream: (name: string) => `/api/stream/${encodeURIComponent(name)}`,
  brandingImage: (name: string, file: string) => `${projectPath(name)}/branding/${encodeURIComponent(file)}`,
  qaFile: (name: string, round: number, file: string) => `${projectPath(name)}/qa/${round}/${encodeURIComponent(file)}`,
  raw: (name: string, path: string) => `${projectPath(name)}/raw?path=${encodeURIComponent(path)}`,
  file: (name: string, path: string) => `${projectPath(name)}/file?path=${encodeURIComponent(path)}`,
  chatUpload: (name: string, file: string) => `${projectPath(name)}/chat-upload/${encodeURIComponent(file)}`,
}
