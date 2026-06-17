# Palette redesign: greyscale + oxblood + gradient

**Date:** 2026-06-17
**Status:** Approved (design), pending implementation plan
**Supersedes:** the warm/vintage amber–plum–jade–rust palette in `frontend/src/index.css`

## Problem

The shipping palette reads "faded." Brainstorming (visual companion) traced this to
three compounding causes, not one:

1. **Intentionally muted hues.** The amber/plum/jade/rust system sits at low
   saturation by design — earthy, vintage. It looks dated rather than crisp.
2. **Grey-dominant application.** `App.css` leans on `var(--border)` (66×) and
   `var(--muted-foreground)` (44×) far more than `var(--primary)` (40×), so color
   appears as thin accents over lots of neutral. The UI is mostly grey with
   occasional muted color.
3. **Off-palette drift.** Hardcoded colors bypass the token system and dull/clash:
   a blue focus glow `rgba(119,167,255,…)` (`App.css:36`, `:789`) and raw Tailwind
   amber/green `rgba(245,158,11,…)` / `rgba(34,197,94,…)` (`App.css:1279`, `:1284`).

The decision was a **full repaint**: new hues *and* bolder application. Cashflow
ships **both light and dark mode** (Connor defaults to dark), so every token is
specified for both. The existing `index.css` is already a clean single-source
token tree, so this is a value swap + drift cleanup, not a structural rewrite.

## Direction

- **Greyscale (cool-neutral / zinc) is the workhorse.** Most surfaces, text, and
  borders are grey. Color is signal, not decoration.
- **Oxblood red `#9B2D3A` is the signature** — and carries "money out" / danger.
  Buttons and primary actions are **oxblood solid**.
- **Orange→pink gradient `linear-gradient(135deg, #FF7847, #E84393)` is the hero.**
  Reserved for the Net/hero stat figure and at most one key CTA per screen.
  **Never on routine controls** (the Import button is oxblood solid, not gradient —
  resolved so the hero figure and the button never twin).
- **Green is "money in" / positive only.** Locked one notch deeper than the first
  pass at Connor's request.

## Token ramps (locked)

### Greyscale — zinc

| step | hex | step | hex |
|---|---|---|---|
| 50 | `#FAFAFA` | 500 | `#71717A` |
| 100 | `#F4F4F5` | 600 | `#52525B` |
| 200 | `#E4E4E7` | 700 | `#3F3F46` |
| 300 | `#D4D4D8` | 800 | `#27272A` |
| 400 | `#A1A1AA` | 900 | `#18181B` |
|  |  | 950 | `#09090B` |

### Oxblood — signature + money-out + danger

| step | hex | step | hex |
|---|---|---|---|
| 50 | `#FBEDEE` | 500 | `#9B2D3A` (base) |
| 100 | `#F6D6D9` | 600 | `#82252F` |
| 200 | `#E9A8AF` | 700 | `#661C26` |
| 300 | `#DA7B85` | 800 | `#4A141B` |
| 400 | `#C44E5B` | 900 | `#2E0C10` |

### Green — money-in / positive (deeper, locked)

| step | hex |
|---|---|
| 100 | `#D1FAE5` |
| 200 | `#7DDCAE` |
| 300 | `#35BE83` ← **dark positive** |
| 500 | `#0FA06C` |
| 600 | `#0A875D` ← **light positive** |
| 700 | `#086F4C` |

### Gradient — hero

`--gradient-hero: linear-gradient(135deg, #FF7847, #E84393)` (orange → pink). New token.

### Chart categorical set

Greyscale + one red cannot carry 6+ series, so multi-series charts draw from a
fixed categorical set. Semantics (spend = oxblood, income = green) stay reserved;
this set is only for categorical breakdowns.

`#9B2D3A` oxblood · `#FF7847` orange · `#E84393` pink · `#35BE83` green ·
`#5EA8E0` steel-blue · `#A1A1AA` grey · `#DA7B85` oxblood-300 · `#F5C451` amber

## Semantic tokens (both modes)

| token | dark | light |
|---|---|---|
| `--background` | `#0A0A0B` | `#F4F4F5` |
| `--card` | `#141416` | `#FFFFFF` |
| `--popover` | `#1A1A1D` | `#FFFFFF` |
| `--muted` | `#1F1F22` | `#F4F4F5` |
| `--border` | `#242427` | `#E4E4E7` |
| `--border-strong` | `#3A3A3E` | `#D4D4D8` |
| `--foreground` | `#EDEDEF` | `#18181B` |
| `--muted-foreground` | `#8B8B90` | `#71717A` |
| `--primary` | `#9B2D3A` | `#9B2D3A` |
| `--primary-hover` | `#82252F` | `#82252F` |
| `--primary-foreground` | `#FBEDEE` | `#FFFFFF` |
| `--secondary` | `#1F1F22` + `--border-strong` | `#FFFFFF` + `--border-strong` |
| `--gradient-hero` | orange→pink | orange→pink |
| `--text-link` | `#DA7B85` (oxblood-300) | `#82252F` (oxblood-600) |
| `--positive` | `#35BE83` | `#0A875D` |
| `--negative` (money out) | oxblood-tinted red, AA on `--card` | `#9B2D3A` |
| `--danger` / `--destructive` | oxblood-500/600 | oxblood-500/600 |
| `--danger-bg` | oxblood-900 tint | oxblood-50 |
| `--ring` (focus) | oxblood-400 | oxblood-500 |

**AA requirement:** every text/icon token must clear WCAG AA (≥4.5:1 body, ≥3:1
large/UI) against the surface it sits on, in both modes. The `--negative` number
shade on dark is the one to verify and pin during implementation (candidate
`#DA7B85`/oxblood-300; deepen if it fails on `--card`).

## Components in scope

Two deliverables:

### 1. Token overhaul + drift cleanup

- **`frontend/src/index.css`** — replace the amber/plum/jade/rust ramps and warm
  neutrals with the ramps above; remap every semantic token for both
  `:root[data-theme="light"]` and `:root[data-theme="dark"]`; add
  `--gradient-hero`. Keep the existing legacy aliases (`--bg`, `--accent-warm`,
  etc.) pointing at the new values for one migration cycle.
- **`frontend/src/App.css`** — kill the three off-palette sites: blue glow
  (`:36`, `:789`) → oxblood `--ring`/selection; raw Tailwind amber/green
  (`:1279`, `:1284`) → tokens. Rebalance the grey-dominance so oxblood and the
  gradient hero carry real presence (the "bolder application" half of the
  decision) — the Net/hero figure uses `--gradient-hero`, primary buttons use
  oxblood solid.
- Charts wired to the categorical set + reserved spend/income semantics.

### 2. In-app palette page (new Settings section)

- A **living palette reference** under **Settings** (a new section alongside
  `DisplaySection`, e.g. Settings → Appearance → Palette), reading **live from the
  CSS custom properties at runtime** (via `getComputedStyle`) so it can never
  drift from the real tokens. Renders the ramps, gradient, chart set, and semantic
  swatches, and reflects the active theme (uses `ThemeContext`).
- This is a **new view**, not a new primitive — a static reference page, no model
  or route-registry/backend change beyond the frontend Settings sub-route.

## Out of scope

- No backend, model, or API change.
- No new theme beyond the existing light/dark (no system-auto, no extra variants).
- No component-by-component visual redesign beyond what the token swap + drift
  cleanup produce. (Bolder application is achieved through tokens and the few
  hero/button placements above, not a full UI overhaul.)

## Testing

- `appRouteOrder` / settings routing integration tests stay green; add a test that
  the new Settings palette section mounts.
- Contrast: an automated AA check (or documented manual check) for every semantic
  text token against its surface, both modes.
- Visual smoke: dark + light dashboard render with gradient Net hero, oxblood
  buttons, green income, oxblood spend.
- Grep guard (optional): a test asserting no `rgba(119,167,255` / raw
  `rgba(245,158,11` / `rgba(34,197,94` remain in `App.css`, so drift can't return.
