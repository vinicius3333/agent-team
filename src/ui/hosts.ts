// The extra host names the dashboard accepts besides loopback and *.ts.net. See docs/adr/0006.

const publicUrlVariables = ["APP_URL", "PUBLIC_URL", "BASE_URL", "ORIGIN", "NEXTAUTH_URL", "NEXT_PUBLIC_APP_URL"]
const hostNamePattern = /^[a-z0-9.-]+$/

function unique(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))]
}

export function parseHostList(value: string | undefined): string[] {
  return unique((value ?? "").split(",").map((host) => host.trim().toLowerCase()))
}

function urlHostName(value: string | undefined): string {
  if (!value || !URL.canParse(value)) return ""
  return new URL(value).hostname.toLowerCase()
}

export function previewHosts(env: Record<string, string | undefined>): string[] {
  const hostname = (env.HOSTNAME ?? "").trim().toLowerCase()
  return unique([
    ...parseHostList(env.AGENT_TEAM_UI_HOSTS),
    ...publicUrlVariables.map((name) => urlHostName(env[name])),
    hostNamePattern.test(hostname) ? hostname : "",
  ])
}
