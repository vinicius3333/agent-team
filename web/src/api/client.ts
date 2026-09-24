import type { Defaults, NewProjectRequest, ProjectDetail, ProjectSummary } from "@/api/types"

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
  mockups: (name: string) => getJson<string[]>(`${projectPath(name)}/mockups`),
  file: (name: string, path: string) => getText(`${projectPath(name)}/file?path=${encodeURIComponent(path)}`),
  transcript: (name: string, file: string) => getText(`${projectPath(name)}/transcript/${encodeURIComponent(file)}`),

  createProject: (body: NewProjectRequest) => post<{ name: string }>("/api/projects", body),
  run: (name: string) => post<{ started: boolean }>(`${projectPath(name)}/run`, {}),
  approve: (name: string, phase: string) => post<{ started: boolean }>(`${projectPath(name)}/approve`, { phase }),
  feedback: (name: string, phase: string, message: string) => post<{ started: boolean }>(`${projectPath(name)}/feedback`, { phase, message }),
  retry: (name: string, taskId: string) => post<{ started: boolean }>(`${projectPath(name)}/retry`, { taskId }),
}

export const urls = {
  stream: (name: string) => `/api/stream/${encodeURIComponent(name)}`,
  mockup: (name: string, file: string) => `${projectPath(name)}/mockups/${encodeURIComponent(file)}`,
  raw: (name: string, path: string) => `${projectPath(name)}/raw?path=${encodeURIComponent(path)}`,
  file: (name: string, path: string) => `${projectPath(name)}/file?path=${encodeURIComponent(path)}`,
}
