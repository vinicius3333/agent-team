# Brand guide

## Logo

A hexagon split into three facets: one violet, two ink. The facets stand for the agent team working on one product.

| File | Use |
|---|---|
| `logo/symbol.svg` | Favicon and app icon. Switches the ink facets to white in dark mode. |
| `logo/symbol-light.svg` | Symbol on light backgrounds |
| `logo/symbol-dark.svg` | Symbol on dark backgrounds |
| `logo/horizontal-light.svg` | Symbol and wordmark on light backgrounds (README header) |
| `logo/horizontal-dark.svg` | Symbol and wordmark on dark backgrounds |

Rules:

- Keep clear space around the symbol of at least a quarter of its width.
- Do not recolor, rotate, outline, or add effects to the symbol.
- The gaps between facets are transparent. Place the logo on a flat background.
- The wordmark is live text (Quicksand, then system sans). Convert it to outlines before print or before using it where fonts may be missing.

## Color

| Token | Light | Dark | Use |
|---|---|---|---|
| Violet (`--primary`) | `#7C3AED` | `#7C3AED` | Primary actions, active state, focus ring |
| Ink (`--foreground`) | `#0B0B10` | `#F4F4F7` | Text |
| Surface (`--card`) | `#FFFFFF` | `#14141C` | Cards, panels |
| Background (`--background`) | `#F7F7FA` | `#0B0B10` | Page |
| Border (`--border`) | `#E6E6EC` | `#2A2A36` | Dividers, inputs |
| Muted text (`--muted-foreground`) | `#62627A` | `#A1A1B5` | Secondary text |
| Success | `#15803D` | `#22C55E` | Done, passed, live |
| Warning | `#B45309` | `#F59E0B` | Waiting, cooling down |
| Destructive | `#DC2626` | `#F87171` | Failed, blocked |

Every text and background pair meets WCAG 2.2 AA. The full theme lives in `tokens.css` as shadcn/ui variables for Tailwind CSS v4.

## Type and icons

- UI font: Inter, then the system sans. Code and IDs: JetBrains Mono, then the system mono.
- Icons: [Lucide](https://lucide.dev), 1.5 to 2 px stroke, same color as the text beside them.

## Imagery

- `assets/readme-hero.png`: README hero.
- `assets/og-image.png`: social preview, 1200×630.
- `assets/empty-*.png`, `assets/build-failed.png`: references for empty and error states. The app redraws them as SVG so they follow the theme.
- `vision/light-a/`: the chosen dashboard mockups (new project, build running, approval gate, shipped). The logo inside these images is not accurate; use the SVG files.
