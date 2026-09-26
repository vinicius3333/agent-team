# Design system

This describes the agent-team dashboard (`web/`) as it is today. The team imported the app and did not design it. The marketing site (`site/`) uses the same palette and fonts in its own stylesheet (`site/src/index.css`).

The source of truth for the theme is `web/src/index.css`. `design/tokens.css` is a copy of its tokens.

## Principles

- **Violet marks what matters.** `primary` (#7c3aed) is on the main action of each page, the active sidebar item, the current phase dot, and count badges. Everything else stays neutral.
- **Cards on a soft gray canvas.** Pages sit on `background` (#f7f7fa). Content lives in white `Card`s with a 1px `border`.
- **State is always visible.** Every list has a skeleton while loading, an `EmptyState` when empty, and an `Alert` when the server does not answer. Every action shows a `Sonner` toast or an inline message.
- **Works on a phone.** The sidebar becomes a sheet under 768px, grids drop to one column, and mobile controls are at least 40–44px tall.
- **Dark mode through tokens only.** `.dark` on `<html>` swaps the variables. The Settings page picks Light, Dark, or System.

## Color

All colors are CSS variables in `design/tokens.css`, mapped to Tailwind colors in `@theme inline`. Write `bg-primary`, `text-muted-foreground`, and so on.

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` / `foreground` | #f7f7fa / #0b0b10 | #0b0b10 / #f4f4f7 | Page canvas and body text. |
| `card` / `card-foreground` | #ffffff / #0b0b10 | #14141c / #f4f4f7 | Cards, the login card, form panels. |
| `popover` / `popover-foreground` | #ffffff / #0b0b10 | #14141c / #f4f4f7 | Dropdown menus, tooltips, dialogs. |
| `primary` / `primary-foreground` | #7c3aed / #ffffff | #7c3aed / #ffffff | Main buttons (New project, Log in, Approve), links, active nav, current phase, count badges, focus ring. |
| `secondary` / `secondary-foreground` | #f1edfd / #5b21b6 | #221a3a / #ddd6fe | Secondary buttons and badges with a violet tint. |
| `muted` / `muted-foreground` | #f1f1f5 / #62627a | #1c1c26 / #a1a1b5 | Code blocks, quiet panels; descriptions, hints, timestamps. |
| `accent` / `accent-foreground` | #f1edfd / #5b21b6 | #221a3a / #ddd6fe | Hover on ghost and outline buttons, selected toggle items. |
| `destructive` | #dc2626 | #f87171 | Errors, failed runs, delete and reject actions, the "server does not answer" alert. |
| `success` / `success-foreground` | #15803d / #ffffff | #22c55e / #0b0b10 | Done phases (check icon), passed QA, the Live badge. |
| `warning` / `warning-foreground` | #b45309 / #ffffff | #f59e0b / #0b0b10 | Waiting at a gate, budget near its limit, paused runs. |
| `border` / `input` | #e6e6ec | #2a2a36 | Card borders, dividers, input borders. |
| `ring` | #7c3aed | #8b5cf6 | Focus ring, used at 50% (`ring-ring/50`, 3px). |
| `chart-1` … `chart-5` | #7c3aed, #16a34a, #0ea5e9, #d97706, #db2777 | #8b5cf6, #22c55e, #38bdf8, #f59e0b, #f472b6 | Cost and token charts in the project views, in this order. |
| `sidebar` / `sidebar-foreground` | #ffffff / #0b0b10 | #0f0f16 / #f4f4f7 | Left sidebar surface. |
| `sidebar-primary` / `-foreground` | #7c3aed / #ffffff | #7c3aed / #ffffff | Badges on sidebar items. |
| `sidebar-accent` / `-foreground` | #f1edfd / #5b21b6 | #221a3a / #ddd6fe | Active and hovered sidebar item. |
| `sidebar-border` / `sidebar-ring` | #e6e6ec / #7c3aed | #2a2a36 / #8b5cf6 | Sidebar edge and focus. |

Contrast: `foreground` on `background` is above 18:1. `muted-foreground` on `background` is about 5.5:1 in light mode and 7:1 in dark mode. White on `primary` is about 5.7:1. `success` and `warning` with their foreground pairs pass 4.5:1 in both modes.

## Typography

- **Sans:** `font-family: "Inter"` (`--font-sans`, Tailwind `font-sans`), falling back to `ui-sans-serif, system-ui, sans-serif`. The body uses it.
- **Mono:** `font-family: "JetBrains Mono"` (`--font-mono`, Tailwind `font-mono`), falling back to `ui-monospace, monospace`. Used for ids, file paths, code, costs, and the marketing site's headings.
- **Loading:** today neither the dashboard nor the site loads these fonts from a package or a `<link>`. They render only when the viewer has them installed; otherwise the system fallback shows. The package names to load them are `@fontsource-variable/inter` (registers `"Inter Variable"`) and `@fontsource-variable/jetbrains-mono` (registers `"JetBrains Mono Variable"`). This is noted, not changed.
- Numbers in stats and badges use `tabular-nums`.

| Role | Classes | Where |
|---|---|---|
| Page title | `text-2xl font-semibold tracking-tight` | `PageHeader` title |
| Login title | `text-2xl` via `CardTitle` | Login card |
| Card title | `font-semibold leading-none` (`CardTitle`) | Every card |
| Body | `text-sm` | Forms, lists, card content |
| Description | `text-sm text-muted-foreground` | `PageHeader` and `CardDescription` |
| Small / meta | `text-xs text-muted-foreground` | Timestamps, badges, counts |
| Markdown | `.markdown`: h1 `text-xl`, h2 `text-lg` with bottom border, h3 `text-base`, body `text-sm leading-relaxed` | Docs, lead chat, diagnoses |

Weights: 400 body, 500 labels and buttons (`font-medium`), 600 titles (`font-semibold`), 700 on the marketing site hero (`font-bold`).

## Spacing and radius

- Tailwind's 4px scale. Common steps: `gap-2` (8px) inside controls, `gap-4` (16px) between cards and form fields, `gap-6` (24px) between sections.
- Page frame: `main` is `mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8`.
- Cards: `py-6` with `px-6` content (shadcn default); the login card uses `px-8 py-8`.
- Mobile header: `h-14`, sticky, blurred `bg-background/90`.
- Radius: `--radius` is 0.625rem (10px). `rounded-sm` 6px, `rounded-md` 8px (buttons, inputs, badges), `rounded-lg` 10px, `rounded-xl` 14px (cards, skeleton cards).
- Grids: project cards `grid-cols-1 sm:grid-cols-2 xl:grid-cols-3`; forms with a side panel `lg:grid-cols-[minmax(0,1fr)_22rem]`. Every grid child has `min-width: 0` so long paths cannot widen the page.

## Components

Install command for the primitives in `web/src/components/ui/`:

```
npx shadcn@latest add alert badge button card checkbox collapsible dialog dropdown-menu input label progress scroll-area separator sheet sidebar skeleton sonner switch table tabs textarea toggle toggle-group tooltip
```

Shared states for every control: focus shows a 3px `ring-ring/50` ring and a `border-ring`; disabled is `opacity-50` with no pointer events; invalid (`aria-invalid`) shows a `destructive` border and ring.

| Component | Variants | States and use |
|---|---|---|
| `Button` | `default` (primary), `outline`, `secondary`, `ghost`, `link`, `destructive`. Sizes `xs` 24px, `sm` 32px, `default` 36px, `lg` 40px, `icon` 36px, `icon-sm` 32px, `icon-lg` 40px. | One `default` per area for the main action. Hover darkens to 90%. Loading: disabled plus a spinning `Loader2` or a label such as "Logging in…". Forms on mobile use `h-11` (44px). |
| `Badge` | `default`, `secondary`, `outline`, `destructive`, `ghost`, `link` | Status and counts. `StatusBadge` wraps it for run states (running, waiting, failed, done, Live). |
| `Card` | `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | Every content block: project cards, settings sections, incident parts, forms. |
| `Alert` | `default`, `destructive` | Page-level problems: server offline, run stopped (with error lines and **Resume run**), budget reached. |
| `Dialog` | — | Confirmations and focused edits in the project views. Closes with Esc and the `X` button. |
| `Sheet` | side `left` | The mobile sidebar under 768px. |
| `Sidebar` | collapsible to an icon rail | Main navigation. Active item uses `sidebar-accent`. Width cookie `sidebar_state`. |
| `Tabs` | — | Sub-views inside a project page section. |
| `Table` | — | Agent calls, tasks, findings, and budget lists. Scrolls sideways inside its own box on phones. |
| `Input`, `Textarea`, `Label` | — | Every form field. Errors show as `text-sm text-destructive` text under the field with `role="alert"`. |
| `Checkbox`, `Switch` | — | Approval gates and on/off options (Create GitHub repo, Deploy when ready). |
| `Toggle`, `ToggleGroup` | `outline` | Theme picker; target and provider choices. Selected item uses `accent`. |
| `DropdownMenu` | — | Overflow actions. |
| `Collapsible` | — | Sidebar phase groups, long logs. |
| `Progress` | — | Budget used and run progress. |
| `ScrollArea` | — | Event feed and chat history. |
| `Separator` | — | Dividers in cards and the sidebar. |
| `Skeleton` | — | Loading placeholders (`h-44 rounded-xl` for project cards). |
| `Sonner` (`Toaster`, bottom right) | `success`, `error` | Result of every action: "Started <name>", "Importing <name>", failures. |
| `Tooltip` | — | Icon-only buttons and the collapsed sidebar rail. |

Feature components in `web/src/components/`:

- `PageHeader`: title, description, and an actions slot on the right (stacks under the title on phones).
- `EmptyState`: centered illustration, title, text, and action buttons. Illustrations are the React components in `components/illustrations/` (`EmptyProjectsIllustration`, `EmptyActivityIllustration`, `BuildFailedIllustration`).
- `StatusBadge`, `CopyButton`, `ThemeToggle`, `TokenCount`, `Markdown`, `Logo`, `AppSidebar`, `GitIdentityCard`, `NotificationsCard`, `RoleModelsEditor`, `BrandingGallery`, plus folders `project/`, `office/`, `operate/`, `incidents/`.

## Icons

Lucide icons, `size-4` by default inside buttons.

| Icon | Meaning |
|---|---|
| `Plus` | New project, add item |
| `Download` | Import project; install (site) |
| `Loader2` | Loading, with `animate-spin` |
| `Check`, `CheckCircle2` | Done, passed, approved |
| `X`, `CircleMinus` | Close, reject, dismiss |
| `CircleAlert`, `TriangleAlert`, `ServerCrash` | Error, warning, server offline |
| `Play`, `PauseCircle`, `RotateCcw` | Start or resume, paused, retry |
| `ExternalLink`, `Globe` | Opens outside the app, live preview URL |
| `ChevronRight`, `ChevronDown` | Expand, go deeper |
| `LockKeyhole` | Password field on the login card |
| `Sun`, `Moon` | Theme |
| `Stethoscope` | Incidents and the doctor |
| `Coins`, `CircleDollarSign`, `Wallet` | Cost and budget |
| `Bot`, `Users`, `User` | Agents, the team, one role |
| `MessageSquare`, `MessagesSquare`, `Send` | Lead chat |
| `GitPullRequest`, `GitMerge`, `GitBranch` | Changes, merge, branches |
| `House`, `Building`, `FileText`, `Palette`, `ListChecks`, `ShieldCheck` | Build views: Overview, Office, Docs, Branding, Tasks, QA |
| `Megaphone` | Launch: Marketing |
| `Activity`, `ChartColumn`, `Swords`, `ListTodo`, `CalendarClock` | Operate views: Health, Analytics, Competitors, Backlog, Sprints |
| `Cpu`, `SlidersHorizontal` | System views: Runtime, Config |
| `Settings` | Settings page; System phase in the sidebar |
| `LogOut` | Log out (sidebar footer) |
| `PanelLeftClose`, `PanelLeftOpen` | Collapse or expand the sidebar |

## Logo

- Files in `web/public/`: `symbol.svg` (favicon), `symbol-light.svg` and `symbol-dark.svg` (mark per theme), `horizontal-light.svg` and `horizontal-dark.svg` (mark plus word), `og-image.png` (social preview).
- The `Logo` component shows the symbol and the word "agent-team". It sits at the top of the sidebar, in the mobile header (`text-base`), and centered on the login card (`size-9` mark, `text-2xl` word).
- Clear space: at least the mark's height on each side of the horizontal logo. Minimum size: 16px for the mark, 24px tall for the horizontal logo.
- Favicon: `web/index.html` links `/symbol.svg`. The favicon set for generated work lives in `design/favicon/`; this imported app did not get one.
