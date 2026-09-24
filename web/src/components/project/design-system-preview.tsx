import { useMemo, useState, type CSSProperties } from "react"
import { Bell, Check, Loader2, MessageSquarePlus, Moon, Plus, RotateCcw, Sun, Trash2 } from "lucide-react"
import { api, urls } from "@/api/client"
import { useAsync } from "@/api/hooks"
import { EmptyState } from "@/components/empty-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { contrastLevel, contrastRatio, isColor, parseTokens, resolveVariables, toHex, type ContrastLevel, type TokenMap } from "@/lib/design-tokens"
import { cn } from "@/lib/utils"
import { useProjectView } from "./context"

type Mode = "light" | "dark"

const designFiles = { tokens: "design/tokens.css", logo: "design/logo.svg", mark: "design/logo-mark.svg" }
const faviconSizes = [16, 32, 48]
const markSizes = [16, 32, 64, 128]
const surfacePairs = ["background", "card", "popover", "primary", "secondary", "muted", "accent", "destructive", "success", "warning", "sidebar", "sidebar-primary", "sidebar-accent"]
// Text colors that sit on a surface other than their own pair.
const extraChecks: { label: string; foreground: string; background: string }[] = [
  { label: "muted-foreground on background", foreground: "--muted-foreground", background: "--background" },
  { label: "muted-foreground on card", foreground: "--muted-foreground", background: "--card" },
  { label: "primary on background (links)", foreground: "--primary", background: "--background" },
  { label: "destructive on background (errors)", foreground: "--destructive", background: "--background" },
]
const typeScale = [
  { className: "text-xs", label: "xs · 12px" },
  { className: "text-sm", label: "sm · 14px" },
  { className: "text-base", label: "base · 16px" },
  { className: "text-lg", label: "lg · 18px" },
  { className: "text-xl", label: "xl · 20px" },
  { className: "text-2xl", label: "2xl · 24px" },
  { className: "text-3xl", label: "3xl · 30px" },
  { className: "text-4xl", label: "4xl · 36px" },
]
const weights = [
  { className: "font-normal", label: "400" },
  { className: "font-medium", label: "500" },
  { className: "font-semibold", label: "600" },
  { className: "font-bold", label: "700" },
]
const radii = ["rounded-sm", "rounded-md", "rounded-lg", "rounded-xl", "rounded-full"]

const levelClasses: Record<ContrastLevel, string> = {
  AAA: "bg-success/15 text-success",
  AA: "bg-success/15 text-success",
  "AA large": "bg-warning/15 text-warning",
  fail: "bg-destructive/15 text-destructive",
}

async function optionalFile(project: string, path: string): Promise<string | null> {
  return api.file(project, path).catch(() => null)
}

function foregroundOf(name: string): string {
  return name === "background" ? "--foreground" : `--${name}-foreground`
}

function svgDataUrl(svg: string, tokens: TokenMap): string {
  const themed = resolveVariables(svg, tokens).replace(/currentColor/g, tokens["--foreground"] ?? "#000")
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themed)}`
}

function ContrastBadge({ foreground, background }: { foreground?: string; background?: string }) {
  const ratio = foreground && background ? contrastRatio(foreground, background) : null
  if (ratio === null) return <span className="text-xs text-muted-foreground">no contrast data</span>
  const level = contrastLevel(ratio)
  return (
    <span className={cn("rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold", levelClasses[level])} title="WCAG 2.2: text needs 4.5:1, large text and icons 3:1">
      {ratio.toFixed(2)}:1 {level}
    </span>
  )
}

function ColorInput({ name, value, onChange }: { name: string; value: string; onChange: (name: string, value: string) => void }) {
  return (
    <label className="flex min-w-0 items-center gap-1.5 text-xs" title={`Try another value for ${name}`}>
      <input type="color" value={toHex(value) ?? "#000000"} onChange={(event) => onChange(name, event.target.value)} className="size-6 shrink-0 cursor-pointer rounded border bg-transparent p-0" aria-label={`Edit ${name}`} />
      <span className="min-w-0 truncate font-mono">{name}</span>
      <span className="ml-auto shrink-0 font-mono text-muted-foreground">{toHex(value) ?? value}</span>
    </label>
  )
}

function ColorsSection({ tokens, onEdit }: { tokens: TokenMap; onEdit: (name: string, value: string) => void }) {
  const pairs = surfacePairs.filter((name) => tokens[`--${name}`] && tokens[foregroundOf(name)])
  const paired = new Set(pairs.flatMap((name) => [`--${name}`, foregroundOf(name)]))
  const singles = Object.entries(tokens).filter(([name, value]) => !paired.has(name) && isColor(value))
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {pairs.map((name) => {
          const background = tokens[`--${name}`]
          const foreground = tokens[foregroundOf(name)]
          return (
            <div key={name} className="overflow-hidden rounded-lg border">
              <div className="flex h-20 items-center justify-between gap-2 px-3" style={{ background, color: foreground }}>
                <span className="text-2xl font-semibold">Aa</span>
                <span className="text-sm">{name}</span>
              </div>
              <div className="flex flex-col gap-1.5 bg-card p-2 text-card-foreground">
                <ContrastBadge foreground={foreground} background={background} />
                <ColorInput name={`--${name}`} value={background} onChange={onEdit} />
                <ColorInput name={foregroundOf(name)} value={foreground} onChange={onEdit} />
              </div>
            </div>
          )
        })}
      </div>
      <div>
        <p className="mb-2 text-sm font-semibold">Text on other surfaces</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {extraChecks
            .filter((check) => tokens[check.foreground] && tokens[check.background])
            .map((check) => (
              <li key={check.label} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm" style={{ background: tokens[check.background], color: tokens[check.foreground] }}>
                <span className="min-w-0 flex-1 truncate">{check.label}</span>
                <ContrastBadge foreground={tokens[check.foreground]} background={tokens[check.background]} />
              </li>
            ))}
        </ul>
      </div>
      {singles.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-semibold">Other colors</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {singles.map(([name, value]) => (
              <div key={name} className="flex items-center gap-2 rounded-md border bg-card p-2">
                <span className="size-8 shrink-0 rounded-md border" style={{ background: value }} />
                <div className="min-w-0 flex-1">
                  <ColorInput name={name} value={value} onChange={onEdit} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ComponentsSection() {
  const [disabled, setDisabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [progress, setProgress] = useState(60)
  const spinner = loading ? <Loader2 className="animate-spin" /> : null
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-4 rounded-md border border-dashed p-3 text-sm">
        <span className="font-medium">States:</span>
        <label className="flex items-center gap-2">
          <Switch checked={disabled} onCheckedChange={setDisabled} /> Disabled
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={loading} onCheckedChange={setLoading} /> Loading
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={invalid} onCheckedChange={setInvalid} /> Error
        </label>
      </div>

      <section className="flex flex-col gap-2">
        <p className="text-sm font-semibold">Button</p>
        <div className="flex flex-wrap items-center gap-2">
          {(["default", "secondary", "outline", "ghost", "destructive", "link"] as const).map((variant) => (
            <Button key={variant} variant={variant} disabled={disabled || loading}>
              {spinner}
              {variant}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={disabled || loading}>
            {spinner ?? <Plus />} Small
          </Button>
          <Button disabled={disabled || loading}>{spinner ?? <Plus />} Default</Button>
          <Button size="lg" disabled={disabled || loading}>
            {spinner ?? <Plus />} Large
          </Button>
          <Button size="icon" variant="outline" disabled={disabled || loading} aria-label="Delete">
            {spinner ?? <Trash2 />}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-sm font-semibold">Badge</p>
        <div className="flex flex-wrap gap-2">
          {(["default", "secondary", "outline", "destructive"] as const).map((variant) => (
            <Badge key={variant} variant={variant}>
              {variant}
            </Badge>
          ))}
          <Badge className="bg-success text-success-foreground">success</Badge>
          <Badge className="bg-warning text-warning-foreground">warning</Badge>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold">Form</p>
          <div className="grid gap-1.5">
            <Label htmlFor="preview-email">Email</Label>
            <Input id="preview-email" type="email" placeholder="ana@example.com" disabled={disabled} aria-invalid={invalid || undefined} />
            {invalid ? <p className="text-sm text-destructive">Enter a valid email address.</p> : <p className="text-sm text-muted-foreground">We never share your email.</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="preview-notes">Notes</Label>
            <Textarea id="preview-notes" placeholder="Anything to add?" disabled={disabled} aria-invalid={invalid || undefined} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox defaultChecked disabled={disabled} /> Remember me
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch defaultChecked disabled={disabled} /> Email notifications
          </label>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Card title</CardTitle>
            <CardDescription>Secondary text in muted-foreground.</CardDescription>
            <CardAction>
              <Badge variant="secondary">New</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p>Body text on the card surface.</p>
            <Progress value={progress} />
            <input type="range" min={0} max={100} value={progress} onChange={(event) => setProgress(Number(event.target.value))} aria-label="Progress value" className="accent-primary" />
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm" disabled={disabled || loading}>
              {spinner ?? <Check />} Save
            </Button>
            <Button size="sm" variant="outline" disabled={disabled}>
              Cancel
            </Button>
          </CardFooter>
        </Card>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <Alert>
          <Bell />
          <AlertTitle>Heads up</AlertTitle>
          <AlertDescription>The draw runs when everyone joins.</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <Bell />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>We could not save your changes. Try again.</AlertDescription>
        </Alert>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">Tabs</p>
          <Tabs defaultValue="first">
            <TabsList>
              <TabsTrigger value="first">Overview</TabsTrigger>
              <TabsTrigger value="second">Members</TabsTrigger>
              <TabsTrigger value="third" disabled>
                Locked
              </TabsTrigger>
            </TabsList>
            <TabsContent value="first" className="text-sm text-muted-foreground">
              Overview content.
            </TabsContent>
            <TabsContent value="second" className="text-sm text-muted-foreground">
              Members content.
            </TabsContent>
          </Tabs>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">Table</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                ["Ana", "Joined"],
                ["Bruno", "Invited"],
                ["Carla", "Joined"],
              ].map(([name, status]) => (
                <TableRow key={name}>
                  <TableCell>{name}</TableCell>
                  <TableCell>
                    <Badge variant={status === "Joined" ? "default" : "outline"}>{status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-sm font-semibold">Loading</p>
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        </div>
      </section>
    </div>
  )
}

function TypeSection({ tokens }: { tokens: TokenMap }) {
  const [sample, setSample] = useState("The quick brown fox jumps over the lazy dog")
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Font: <code className="font-mono">{tokens["--font-sans"] ?? "not set (--font-sans)"}</code>. The preview uses it only if the font is installed or loaded here.
      </p>
      <Input value={sample} onChange={(event) => setSample(event.target.value)} aria-label="Sample text" />
      <ul className="flex flex-col gap-2">
        {typeScale.map((step) => (
          <li key={step.className} className="flex items-baseline gap-3 border-b pb-2">
            <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">{step.label}</span>
            <span className={cn("min-w-0 truncate", step.className)}>{sample}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-4">
        {weights.map((weight) => (
          <span key={weight.label} className={cn("text-lg", weight.className)}>
            {weight.label} Aa
          </span>
        ))}
      </div>
    </div>
  )
}

function ShapeSection({ tokens }: { tokens: TokenMap }) {
  const charts = [1, 2, 3, 4, 5].map((index) => `--chart-${index}`).filter((name) => tokens[name])
  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-2 text-sm font-semibold">
          Radius <span className="font-mono text-xs font-normal text-muted-foreground">--radius: {tokens["--radius"] ?? "not set"}</span>
        </p>
        <div className="flex flex-wrap gap-3">
          {radii.map((radius) => (
            <div key={radius} className="flex flex-col items-center gap-1">
              <div className={cn("size-16 border-2 border-primary bg-accent", radius)} />
              <span className="font-mono text-xs text-muted-foreground">{radius.replace("rounded-", "")}</span>
            </div>
          ))}
        </div>
      </div>
      {charts.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-semibold">Charts</p>
          <div className="flex h-32 items-end gap-2 rounded-md border p-3">
            {charts.map((name, index) => (
              <div key={name} className="flex flex-1 flex-col items-center gap-1">
                <div className="w-full rounded-t-md" style={{ background: tokens[name], height: `${40 + ((index * 37) % 60)}%` }} />
                <span className="font-mono text-[11px] text-muted-foreground">{name.slice(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function LogoSection({ project, logo, mark, tokens }: { project: string; logo: string | null; mark: string | null; tokens: TokenMap }) {
  const [missingFavicons, setMissingFavicons] = useState<number[]>([])
  if (!logo && !mark) return <EmptyState title="No logo yet">The designer writes design/logo.svg and design/logo-mark.svg.</EmptyState>
  return (
    <div className="flex flex-col gap-5">
      {logo && (
        <div className="grid gap-3 sm:grid-cols-3">
          {["bg-background", "bg-card", "bg-muted"].map((surface) => (
            <div key={surface} className={cn("flex h-28 flex-col items-center justify-center gap-1 rounded-lg border p-4", surface)}>
              <img src={svgDataUrl(logo, tokens)} alt="Logo" className="max-h-14 max-w-full" />
              <span className="font-mono text-[11px] text-muted-foreground">{surface.replace("bg-", "")}</span>
            </div>
          ))}
        </div>
      )}
      {mark && (
        <div>
          <p className="mb-2 text-sm font-semibold">Mark (favicon source)</p>
          <div className="flex flex-wrap items-end gap-4">
            {markSizes.map((size) => (
              <div key={size} className="flex flex-col items-center gap-1">
                <img src={svgDataUrl(mark, tokens)} alt={`Mark at ${size}px`} width={size} height={size} />
                <span className="font-mono text-[11px] text-muted-foreground">{size}px</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {missingFavicons.length < faviconSizes.length && (
        <div>
          <p className="mb-2 text-sm font-semibold">Rendered favicons</p>
          <div className="flex flex-wrap items-end gap-4">
            {faviconSizes
              .filter((size) => !missingFavicons.includes(size))
              .map((size) => (
                <div key={size} className="flex flex-col items-center gap-1">
                  <img src={urls.raw(project, `design/favicon/favicon-${size}.png`)} alt={`Favicon ${size}px`} width={size} height={size} style={{ imageRendering: "pixelated" }} onError={() => setMissingFavicons((sizes) => [...sizes, size])} />
                  <span className="font-mono text-[11px] text-muted-foreground">{size}px</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

function describeEdits(mode: Mode, edits: TokenMap, original: TokenMap): string {
  const lines = Object.entries(edits).map(([name, value]) => `- ${name}: ${value} (was ${toHex(original[name] ?? "") ?? original[name] ?? "unset"})`)
  return `In design/tokens.css, change these ${mode} mode colors:\n${lines.join("\n")}`
}

// Renders the project's theme with the dashboard's own shadcn components: its tokens override ours inside the frame.
export function DesignSystemPreview({ version = "", onSuggest }: { version?: string; onSuggest?: (text: string) => void }) {
  const { name } = useProjectView()
  const [mode, setMode] = useState<Mode>("light")
  const [edits, setEdits] = useState<Record<Mode, TokenMap>>({ light: {}, dark: {} })
  const { value, loading } = useAsync(
    async () => {
      const [tokens, logo, mark] = await Promise.all([optionalFile(name, designFiles.tokens), optionalFile(name, designFiles.logo), optionalFile(name, designFiles.mark)])
      return { tokens, logo, mark }
    },
    [name, version],
  )
  const parsed = useMemo(() => parseTokens(value?.tokens ?? ""), [value?.tokens])

  if (loading && value === null) return <Skeleton className="h-64 w-full" />
  if (!value?.tokens) return <EmptyState title="No design tokens yet">The designer writes design/tokens.css in the first design step.</EmptyState>

  const original = parsed[mode]
  const tokens = { ...original, ...edits[mode] }
  const editCount = Object.keys(edits[mode]).length
  const onEdit = (token: string, color: string) => setEdits((current) => ({ ...current, [mode]: { ...current[mode], [token]: color } }))
  const frameStyle = { ...tokens, fontFamily: tokens["--font-sans"] } as CSSProperties

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(next) => next && setMode(next as Mode)} aria-label="Theme mode">
          <ToggleGroupItem value="light">
            <Sun /> Light
          </ToggleGroupItem>
          <ToggleGroupItem value="dark">
            <Moon /> Dark
          </ToggleGroupItem>
        </ToggleGroup>
        {editCount > 0 && (
          <>
            <span className="text-sm text-muted-foreground">
              {editCount} color {editCount === 1 ? "change" : "changes"} to try ({mode})
            </span>
            <Button size="sm" variant="ghost" onClick={() => setEdits((current) => ({ ...current, [mode]: {} }))}>
              <RotateCcw /> Reset
            </Button>
            {onSuggest && (
              <Button size="sm" variant="outline" onClick={() => onSuggest(describeEdits(mode, edits[mode], original))}>
                <MessageSquarePlus /> Add to feedback
              </Button>
            )}
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Pick a color to try it here. Nothing changes in the project until you send feedback.</p>
      {/* "light" switches off the dashboard's dark: variants inside the frame when the dashboard itself is dark. */}
      <div className={cn(mode, "rounded-lg border bg-background p-4 text-foreground")} style={frameStyle}>
        <Tabs defaultValue="colors">
          <TabsList className="mb-3 max-w-full overflow-x-auto">
            <TabsTrigger value="colors">Colors</TabsTrigger>
            <TabsTrigger value="components">Components</TabsTrigger>
            <TabsTrigger value="type">Type</TabsTrigger>
            <TabsTrigger value="shape">Radius and charts</TabsTrigger>
            <TabsTrigger value="logo">Logo</TabsTrigger>
          </TabsList>
          <TabsContent value="colors">
            <ColorsSection tokens={tokens} onEdit={onEdit} />
          </TabsContent>
          <TabsContent value="components">
            <ComponentsSection />
          </TabsContent>
          <TabsContent value="type">
            <TypeSection tokens={tokens} />
          </TabsContent>
          <TabsContent value="shape">
            <ShapeSection tokens={tokens} />
          </TabsContent>
          <TabsContent value="logo">
            <LogoSection project={name} logo={value.logo} mark={value.mark} tokens={tokens} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
