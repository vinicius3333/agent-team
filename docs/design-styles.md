# Design styles and the design judge

The design harness has two parts:

1. **Style catalog.** Named visual styles, used by the design agents so that concept directions are truly different and follow a known style.
2. **Design judge.** An eval step that scores the built app's screenshots, so you can see whether a change made the design better or worse.

## The style catalog

`knowledge/design-styles.json` holds 15 styles and 17 fundamentals. Research on current landing pages produced them (September 2026). 19 sites were measured from their computed CSS in Chrome: linear.app, vercel.com, stripe.com, gumroad.com, lusion.co, and others. Each reference marks whether it was measured.

| Id | Name |
| --- | --- |
| `immersive-3d-webgl` | 3D / WebGL immersive (real-time 3D hero) |
| `minimal-saas-dark` | Minimal SaaS, dark product |
| `editorial-serif` | Editorial / serif-led magazine |
| `bento-grid` | Bento grid |
| `neo-brutalism` | Neo-brutalism |
| `glass-aurora` | Glassmorphism / aurora gradient |
| `swiss-grid` | Swiss / typographic grid |
| `playful-illustrated` | Playful / illustrated |
| `dense-technical` | Dense technical, docs-like |
| `retro-y2k-pixel` | Retro / Y2K / pixel |
| `luxury-premium-dark` | Luxury / premium dark |
| `organic-warm-natural` | Organic / warm natural |
| `kinetic-typography` | Kinetic typography |
| `cinematic-full-bleed` | Cinematic full-bleed photo or video |
| `maximalist-collage` | Maximalist collage |

Each style has:

- a description, mood words, and the products it fits and does not fit
- the layout: hero, sections, grid, density, and whitespace
- type pairings, with free substitutes for commercial fonts
- two palettes with eight roles (`background`, `surface`, `border`, `ink`, `muted`, `primary`, `onPrimary`, `secondary`)
- signature details: radius, borders, shadows, textures, imagery, and motion
- implementation notes for React and Tailwind CSS v4, with performance and accessibility rules
- failure modes: what makes the style look cheap, generic, or machine-made
- reference URLs

The fundamentals apply to every style: type scale, tracking, line length, hierarchy, spacing, contrast, the call to action, originality, mobile, performance, and motion.

### How the pipeline uses it

The orchestrator writes the catalog as Markdown into the agent's worktree, in `.agent-team/design-styles/`. That folder is gitignored, so the copy is never committed.

| Phase | What the agent gets |
| --- | --- |
| Architecture | Only when `branding.style` is a 3D style: add three, `@react-three/fiber`, and `@react-three/drei`. |
| Concepts | The catalog. With `auto`, each direction picks a different style that fits the brief. With a fixed style, every direction uses it. Each `style.md` starts with `Style: <id>`. |
| Concept pick | The catalog, to prefer the direction whose style fits the users. |
| Branding | The chosen style's file: keep its signature details, and avoid its failure modes. |
| Design | The chosen style's file and the fundamentals. For a 3D style, the scene and its static poster go in `docs/design.md`. |
| Plan | For a 3D style only: one task for the scene, with the performance and fallback rules. |
| Design review | Each direction is checked against its style's "Avoid for" list and failure modes. Later phases are checked against the chosen style. |

The chosen style is the one in `branding.style`. With `auto`, it is the style on the `Style:` line of the chosen direction's `style.md`.

The concepts phase fails validation when:

- a `style.md` has no `Style:` line
- the line names an unknown style
- two directions use the same style (with `auto`)
- a direction uses a different style from the fixed one

### Settings

| Key | Default | What it does |
| --- | --- | --- |
| `branding.style` | `auto` | `auto`: each concept direction picks a different catalog style. A style id: every direction uses that style. |

The dashboard's **New project** form has a **Visual style** field under Options. It shows the palette, the description, and who the style fits. The field is off when branding is off or the target is an API.

At the concepts gate, each direction card shows:

- its style's name, with a **3D** badge for a WebGL style
- the mood
- the direction's own colors, read from the background, surface, ink, primary, and secondary lines of its `style.md`
- who the style fits

**Style blocks** under the cards shows each full `style.md`. Directions drawn before the catalog show their raw style block in the card. The prototypes are in `docs/mockups/design-styles/`.

### 3D styles

`immersive-3d-webgl` has `"webgl": true`. For projects that use it:

- The react-vite template (v3) has a `## 3D (optional)` section for the architect and the planner:
  - Load the scene lazily, and paint a static poster first.
  - Fall back to the poster on phones, without WebGL, and with reduced motion.
  - Keep every asset bundled. The QA browser has no internet, so a CDN request fails the smoke check.
  - Clamp the pixel ratio, and keep all text in HTML.
- Three knowledge lessons with `stacks: ["@react-three/fiber"]` reach workers and reviewers once the project depends on it.

Headless Chromium renders WebGL in software, so QA screenshots of a 3D hero are slow. They can also look plainer than a real GPU render.

### Change the catalog

Edit `knowledge/design-styles.json`. `npm test` checks every style:

- ids are kebab-case and unique
- required fields are filled
- palette colors are `#RRGGBB`
- `ink` and `muted` on `background`, and `onPrimary` on `primary`, pass WCAG AA (4.5:1)

## The design judge

After each web brief in `eval run`, the `evaluator` role runs with `prompts/design-judge.md`. It reads:

- the screenshots from the last QA round, desktop and mobile
- the branding images
- the chosen style's file and the fundamentals

It scores eight dimensions from 0 to 100: `hierarchy`, `typography`, `color`, `layout`, `style_fidelity`, `originality`, `mobile`, and `polish`. The orchestrator computes the mean. The judge also lists at most 8 issues.

- The score goes to the brief's `design` field in the result file, and to `.agent-team/evaluations/design.json` in the project.
- The judge skips an API brief, a run with no QA screenshots, and a run whose budget is spent. It then records `null` and logs why.
- `eval compare` shows a `design` column and flags a drop of more than 10 points as a regression. Scores move a few points between identical runs.
- The judge's cost counts toward the brief's budget.

The `styled-landing` brief (tier `full`) runs the whole path: three concept directions from three different styles, then branding, the build, QA, and the judge.

```sh
node src/cli.ts eval run --brief styled-landing --label styles
```
