import { ExternalLink, GitMerge, GitPullRequest, FolderGit2, KanbanSquare } from "lucide-react"
import { CopyButton } from "@/components/copy-button"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useProjectView } from "./context"

export function GithubCard() {
  const { detail } = useProjectView()
  const github = detail.github
  if (!github) return null
  const merged = github.pullRequests.filter((pr) => pr.state === "MERGED").length
  const open = github.pullRequests.filter((pr) => pr.state === "OPEN").length
  const repoLabel = github.repoUrl?.replace(/^https:\/\//, "")
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderGit2 className="size-5" aria-hidden="true" /> GitHub
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {github.repoUrl && (
          <div className="flex items-center gap-1">
            <a href={github.repoUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-sm font-medium text-primary hover:underline">
              {repoLabel}
            </a>
            <CopyButton value={github.repoUrl} label="Copy repo URL" />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="flex items-center gap-2">
            <GitMerge className="size-4 text-success" aria-hidden="true" /> {merged} merged PRs
          </div>
          <div className="flex items-center gap-2">
            <GitPullRequest className="size-4 text-primary" aria-hidden="true" /> {open} open PRs
          </div>
          {github.epic && (
            <div className="col-span-2 text-muted-foreground">
              Epic{" "}
              {github.repoUrl ? (
                <a href={`${github.repoUrl}/issues/${github.epic}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  #{github.epic}
                </a>
              ) : (
                `#${github.epic}`
              )}
            </div>
          )}
        </div>
        {github.pullRequests.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">All pull requests ({github.pullRequests.length})</summary>
            <ul className="mt-2 flex max-h-60 flex-col gap-1 overflow-y-auto">
              {github.pullRequests.map((pr) => (
                <li key={pr.number}>
                  <a href={pr.url} target="_blank" rel="noopener noreferrer" className="flex gap-2 rounded px-1 py-0.5 hover:bg-muted">
                    <span className="font-mono text-xs text-muted-foreground">#{pr.number}</span>
                    <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                    <span className="text-xs text-muted-foreground lowercase">{pr.state}</span>
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap gap-2">
          {github.repoUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={github.repoUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink /> View repository
              </a>
            </Button>
          )}
          {github.projectUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={github.projectUrl} target="_blank" rel="noopener noreferrer">
                <KanbanSquare /> View project board
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
