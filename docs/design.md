# Design

This describes the agent-team screens as they are today. The team imported the app and did not design it. Styles, components, and icons are in `docs/design-system.md`; colors are in `design/tokens.css`. There are no branding images in `design/branding/`, so no screen has a `Branding:` line.

Two front ends exist:

- The **dashboard** (`web/`), served by `agent-team ui`. All its pages sit behind the login when a login is set.
- The **marketing site** (`site/`), a separate package on GitHub Pages. Its page is described first, but it is not a dashboard route.

## Screens

### Marketing site landing

User stories: US-01
Access: public
Site path: `/` on the GitHub Pages site (not a dashboard route; the dashboard's `/` is the projects list).

Layout at 1280px:

```
+----------------------------------------------------------------------+
| [symbol] agent-team   How it works  Control  Self-hosted  Install [GH]|  sticky header
+----------------------------------------------------------------------+
|                pixel-art field background (violet)                    |
|           From a paragraph to a pull request.   (font-mono, 6xl)     |
|   agent-team turns a plain-text brief into a tested web app ...      |
|        [Download Install agent-team]  [Star Star on GitHub]          |
|                    brief card -> role orbit animation                |
+----------------------------------------------------------------------+
| #pipeline  "How it works" / Ten phases, one brief.  phase cards      |
+----------------------------------------------------------------------+
| #control   "You stay in control" / Autonomous where you want it.     |
+----------------------------------------------------------------------+
| #runners   "Self-hosted" / Runs on your machine, with your CLIs.     |
+----------------------------------------------------------------------+
| #install   "Quick start" / Your first build in three steps. code+copy|
+----------------------------------------------------------------------+
| CTA band: Write the brief. Approve the gates. Ship the app. [Install]|
+----------------------------------------------------------------------+
| footer: links, GitHub, license                                       |
+----------------------------------------------------------------------+
```

Layout at 390px:

```
+------------------------------+
| [symbol] agent-team  [GitHub]|
+------------------------------+
| From a paragraph to a        |
| pull request. (4xl, center)  |
| one-line promise             |
| [Install agent-team]  full w |
| [Star on GitHub]      full w |
+------------------------------+
| sections stacked, 1 column   |
| code blocks scroll inside    |
+------------------------------+
| CTA band, footer             |
+------------------------------+
```

At 768px: the hero heading grows to `text-5xl`, buttons sit side by side, and section cards use two columns.

States: static page, so no loading, empty, or error states. The copy buttons in the install section show a check after copying.

Illustrations: none as image files. The hero uses animated React components (`pixel-field`, `pixel-art`, `role-orbit`, `brief-card`).

API calls: none.

### Login

User stories: US-02
Access: public
Route: `/` (the login card replaces every dashboard page when the visitor is not logged in; there is no separate `/login` URL)

Layout at 1280px:

```
+----------------------------------------------------------------------+
|                           bg-background                              |
|                  +-------------------------------+                   |
|                  |      [symbol] agent-team      |                   |
|                  |  Log in                       |                   |
|                  |  Enter the dashboard password.|                   |
|                  |  Password                     |                   |
|                  |  [lock] [..................]  |  h-11             |
|                  |  Wrong password.  (red text)  |                   |
|                  |  [          Log in          ] |  primary, h-11    |
|                  +-------------------------------+  max-w-md card    |
+----------------------------------------------------------------------+
```

Layout at 390px:

```
+------------------------------+
|  +------------------------+  |
|  |  [symbol] agent-team   |  |
|  |  Log in                |  |
|  |  [lock] [password....] |  |
|  |  [       Log in      ] |  |
|  +------------------------+  |
+------------------------------+
```

At 768px: no change; the card stays centered at up to 448px wide.

States:
- Empty: **Log in** is disabled until the field has text.
- Loading: the button reads "Logging in…" and is disabled.
- Error: text under the field with `role="alert"`: "Wrong password." or "Too many tries. Try again in N minutes." The field gets `aria-invalid`.
- Success: the requested page renders in place.

API calls: `GET /api/auth/session`, `POST /api/auth/login`.

### Projects

User stories: US-03, US-04, US-05
Access: signed in
Route: `/`

Layout at 1280px:

```
+------------+---------------------------------------------------------+
| [logo] [<] | Projects                      [Import project][+ New]  |
| PROJECTS + | Every build your agent team runs on this server.        |
|  demo      |                                                         |
|  shop      | +---------------+ +---------------+ +---------------+   |
| INCIDENTS 2| | name  [badge] | | name  [badge] | | name  [badge] |   |
| Settings   | | brief excerpt | | brief excerpt | | brief excerpt |   |
|            | | phase, cost   | | phase, cost   | | phase, cost   |   |
| [theme][->]| +---------------+ +---------------+ +---------------+   |
+------------+---------------------------------------------------------+
```

Layout at 390px:

```
+------------------------------+
| [=] [symbol] agent-team      |  sticky h-14 header
+------------------------------+
| Projects                     |
| Every build your agent ...   |
| [Import project] [+ New]     |
| +--------------------------+ |
| | project card             | |
| +--------------------------+ |
| | project card             | |
+------------------------------+
```

At 768px: the sidebar shows, and cards use two columns (three from 1280px, `xl`).

States:
- Loading: three `Skeleton` cards (`h-44 rounded-xl`).
- Empty: `Card` with `EmptyState`, the `EmptyProjectsIllustration`, "No projects yet", "Describe an idea and your agent team plans, designs, and builds it.", **Start your first project** and **Import an existing app**.
- Error: destructive `Alert` "The server does not answer" with "Check that agent-team ui is running. This page retries every 5 seconds."
- Success: the card grid; each card links to its project page.

Illustrations: `EmptyProjectsIllustration` (React component) centered above the empty-state title.

API calls: `GET /api/projects` (polled).

### New project

User stories: US-03
Access: signed in
Route: `/new`

Layout at 1280px:

```
+------------+---------------------------------------------------------+
| sidebar    | New project                                             |
|            | +-------------------------------------+ +-------------+ |
|            | | Project name [...........]          | | Your agent  | |
|            | | Product brief [textarea.........]   | | team        | |
|            | | Target  (Web)(API)(Both)            | | roles and   | |
|            | | Stack [Custom / template v]         | | models      | |
|            | | Worker (Claude)(Codex)              | |             | |
|            | | Gates [x] spec [x] design ...       | |             | |
|            | | [ ] Create GitHub repo              | |             | |
|            | | [ ] Deploy when ready               | |             | |
|            | | Branding ...                        | +-------------+ |
|            | | [          Start build            ] |   22rem panel   |
|            | +-------------------------------------+                 |
+------------+---------------------------------------------------------+
```

Layout at 390px:

```
+------------------------------+
| [=] agent-team               |
+------------------------------+
| New project                  |
| form fields, one column      |
| checkboxes two per row       |
| Your agent team card below   |
| [ Start build ]  full width  |
+------------------------------+
```

At 768px: still one column; the side panel moves to the right from `lg` (1024px).

States:
- Loading: template and default lists load before the selects fill.
- Empty / error: text under the field, for example "Describe what you want to build." or the project name rule (lowercase letters, digits, and dashes).
- Loading on submit: the button is disabled with a spinner.
- Success: toast "Started <name>", then the project page opens.

API calls: `GET /api/templates`, `GET /api/defaults`, `POST /api/projects`.

### Import project

User stories: US-04
Access: signed in
Route: `/import`

Layout at 1280px:

```
+------------+---------------------------------------------------------+
| sidebar    | Import project                                          |
|            | +-------------------------------------+ +-------------+ |
|            | | Source (Git URL)(Local folder)      | | Your import | |
|            | | URL or path [...................]   | | team        | |
|            | | Project name [..........]           | | importer,   | |
|            | | GitHub (Source repo)(New)(None)     | | PM, arch,   | |
|            | | Gates [x] spec [x] arch [x] design  | | designer    | |
|            | | [ ] Deploy changes                  | +-------------+ |
|            | | [            Import              ]  |                 |
|            | +-------------------------------------+                 |
+------------+---------------------------------------------------------+
```

Layout at 390px:

```
+------------------------------+
| [=] agent-team               |
+------------------------------+
| Import project               |
| fields, one column           |
| Your import team card below  |
| [ Import ]  full width       |
+------------------------------+
```

At 768px: still one column; the side panel moves right from 1024px.

States:
- Error: text under the field: "Paste the repository URL.", "Type the folder's full path.", "Use the full path, starting with /.", or "Only a GitHub URL can use the source repo for pull requests."
- Loading: the submit button is disabled with a spinner.
- Success: toast "Importing <name>", then the project page opens.

API calls: `GET /api/defaults`, `POST /api/projects/import`.

### Project

User stories: US-05, US-06, US-07
Access: signed in
Path: `/projects/:name/:phase/:view` (dynamic, so no `Route:` line; `/projects/:name` redirects to the current phase)

The sidebar lists the project's phases and views. Build: Overview, Chat (the Lead), Office, Docs, Branding, Tasks, QA. Launch: Overview, Marketing. Operate: Overview, Health, Analytics, Competitors, Backlog, Sprints, Changes. System: Agent calls, Runtime, Budget, Config. A done phase shows a green check, the current phase a violet dot, and views with open items a violet count badge.

Layout at 1280px (Build / Overview):

```
+------------+---------------------------------------------------------+
| [logo]     | demo  [Running]                       [Live] preview url|
| PROJECTS   | +-----------------------------------------------------+ |
|  demo      | | ! Waiting at the design gate  [Approve][Request ch.]| |
|  BUILD   * | +-----------------------------------------------------+ |
|   Overview | +-----------+ +-----------+ +-----------+ +---------+  |
|   Chat     | | Cost      | | Elapsed   | | Tasks     | | Phase   |  |
|   Tasks  3 | +-----------+ +-----------+ +-----------+ +---------+  |
|   QA       | +-------------------------------+ +-----------------+  |
|  LAUNCH    | | Pipeline phases               | | Live events     |  |
|  OPERATE   | +-------------------------------+ +-----------------+  |
|  SYSTEM    |                                                        |
+------------+---------------------------------------------------------+
```

Layout at 390px:

```
+------------------------------+
| [=] demo / Overview          |
+------------------------------+
| banner (gate, stop, budget)  |
| [Approve] [Request changes]  |
| +-----------+ +-----------+  |
| | Cost      | | Elapsed   |  |
| +-----------+ +-----------+  |
| phases, events stacked       |
+------------------------------+
```

At 768px: the sidebar shows, and the stat cards stay in two columns (four from 1024px).

States:
- Loading: skeletons for the title, a banner, four stat cards, and the main panel.
- Empty: unknown project shows `EmptyState` with **Back to projects**. Empty views (no events, no findings) use `EmptyActivityIllustration`.
- Error: a stopped run shows a destructive banner with the reason, key error lines, and **Resume run**. A budget stop shows **Raise budget and resume**. A failed build uses `BuildFailedIllustration`.
- Success: gate banners with **Approve** and **Request changes**; scope cards with **Approve and retry** and **Reject**; toasts after each action. The page updates live while the run is active.

Illustrations: `EmptyActivityIllustration` and `BuildFailedIllustration` (React components) centered in empty and failed states.

API calls: `GET /api/projects/:name`, `GET /api/stream/:name` (Server-Sent Events), `GET /api/projects/:name/{markdown,files,file,raw,transcript/:file,qa,branding,mockups,concepts,operate,sprints,findings}`, the POST routes for gates, scope, resume, budget, chat, changes, findings, sprints, and operate agents.

### Incidents

User stories: US-08
Access: signed in
Route: `/incidents`

Layout at 1280px:

```
+------------+---------------------------------------------------------+
| sidebar    | Incidents                                               |
|            | +-----------------------------------------------------+ |
|            | | [Stethoscope] project  reason        status   time >| |
|            | +-----------------------------------------------------+ |
|            | | [Stethoscope] project  reason        status   time >| |
|            | +-----------------------------------------------------+ |
+------------+---------------------------------------------------------+
```

Layout at 390px:

```
+------------------------------+
| [=] agent-team               |
+------------------------------+
| Incidents                    |
| card: project, reason        |
|       status, time        >  |
| card ...                     |
+------------------------------+
```

At 768px: the sidebar shows; rows keep one column.

States:
- Loading: `Skeleton` rows (`h-10`).
- Empty: `EmptyState` "No incidents".
- Error: `EmptyState` "Could not load incidents".
- Success: list, newest first; each row opens the detail.

API calls: `GET /api/incidents`.

### Incident detail

User stories: US-08
Access: signed in
Path: `/incidents/:project/:id` (dynamic, so no `Route:` line)

Layout at 1280px:

```
+------------+---------------------------------------------------------+
| sidebar    | Incident                                                |
|            | +-----------------+ +---------------------------------+ |
|            | | Stop            | | Diagnosis (markdown)            | |
|            | | reason, error   | |                                 | |
|            | +-----------------+ +---------------------------------+ |
|            | | Actions taken   | | Doctor transcripts              | |
|            | +-----------------+ +---------------------------------+ |
+------------+---------------------------------------------------------+
```

Layout at 390px: all cards stack in one column: Stop, Diagnosis, Actions taken, Doctor transcripts.

At 768px: still one column; two columns start at 1024px (`lg:grid-cols-2`).

States:
- Loading: one `Skeleton` block (`h-64`).
- Empty: Diagnosis reads "The doctor has not answered yet."
- Error: `EmptyState` "Could not load this incident".
- Success: all four cards filled.

API calls: `GET /api/incidents/:project/:id`, `GET /api/projects/:name`.

### Settings

User stories: US-02 (admin setup; the spec leaves settings out of its stories)
Access: signed in
Route: `/settings`

Layout at 1280px:

```
+------------+---------------------------------------------------------+
| sidebar    | Settings                                                |
|            | +-----------------------------------------------------+ |
|            | | Theme   [Light][Dark][System]                       | |
|            | +-----------------------------------------------------+ |
|            | | Git identity  name, email  [Save]                   | |
|            | +-----------------------------------------------------+ |
|            | | Notifications  channels  [Send test]                | |
|            | +-----------------------------------------------------+ |
|            | | Server  key : value rows                            | |
|            | +-----------------------------------------------------+ |
+------------+---------------------------------------------------------+
```

Layout at 390px: the same cards stacked full width; the theme toggle group wraps if needed.

At 768px: the sidebar shows; cards stay one column.

States:
- Loading: cards show skeletons while the git identity and notifications load.
- Error: text in the card and an error toast when saving or testing fails.
- Success: toast after saving the git identity or sending a test notification. The theme changes at once.

API calls: `GET /api/git-identity`, `POST /api/git-identity`, `GET /api/notifications`, `POST /api/notifications/test`.

### Not found

User stories: none (catch-all page for unknown dashboard URLs)
Access: signed in
Route: `/not-found`

Layout at 1280px:

```
+------------+---------------------------------------------------------+
| sidebar    | +-----------------------------------------------------+ |
|            | |           This page does not exist                  | |
|            | |             [Back to projects]                      | |
|            | +-----------------------------------------------------+ |
+------------+---------------------------------------------------------+
```

Layout at 390px: the same card, full width under the mobile header.

At 768px: the sidebar shows.

States: one static state.

API calls: none.

## Navigation

- The left `Sidebar` is the main navigation on the dashboard: logo (links to `/`), the projects list with a **New project** `+` action, the open project's phases and views, **Incidents** with an open-count badge, **Settings**, the theme toggle, and **Log out**. It collapses to an icon rail on desktop.
- Under 768px the sidebar opens as a `Sheet` from the menu button in the sticky mobile header. The header shows the logo, or `project / view` on a project page.
- The Projects page links to **New project** (`/new`), **Import project** (`/import`), and each project card.
- Creating or importing a project opens its project page. Incident rows open the incident detail.
- The marketing site has no link to the dashboard; its header links jump to `#pipeline`, `#control`, `#runners`, and `#install`.

Login: /

The login card has one password field and a **Log in** button. It has no email field: the dashboard uses one shared password, not accounts. When no login is set and the server listens on loopback only, there is no login card.
