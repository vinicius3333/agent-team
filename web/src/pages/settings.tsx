import { useProjectList } from "@/api/projects-context"
import { NotificationsCard } from "@/components/notifications-card"
import { PageHeader } from "@/components/page-header"
import { themeOptions } from "@/components/theme-toggle"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useTheme, type Theme } from "@/hooks/use-theme"

export function SettingsPage() {
  const { theme, setTheme } = useTheme()
  const { online, projects } = useProjectList()
  return (
    <>
      <PageHeader title="Settings" description="Preferences for this browser and facts about this server." />
      <div className="grid max-w-3xl gap-4">
        <Card>
          <CardHeader>
            <CardTitle id="theme-label">Theme</CardTitle>
            <CardDescription>System follows your device. The choice is saved in this browser.</CardDescription>
          </CardHeader>
          <CardContent>
            <ToggleGroup type="single" variant="outline" value={theme} onValueChange={(value) => value && setTheme(value as Theme)} aria-labelledby="theme-label">
              {themeOptions.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value} className="px-4 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground">
                  <option.icon /> {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </CardContent>
        </Card>
        <NotificationsCard />
        <Card>
          <CardHeader>
            <CardTitle>Server</CardTitle>
            <CardDescription>The dashboard talks to agent-team ui on this host.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Status</dt>
              <dd>{online ? "Connected" : "Unreachable"}</dd>
              <dt className="text-muted-foreground">Projects</dt>
              <dd>{projects?.length ?? "—"}</dd>
              <dt className="text-muted-foreground">Models</dt>
              <dd>Each project keeps its roles and models in its own pipeline.yaml.</dd>
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
