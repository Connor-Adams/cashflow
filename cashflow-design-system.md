# Cashflow Design System

A portable, self-contained briefing of the Cashflow product's design system — colors,
typography, spacing, primitives, and usage rules. Built for designing new Cashflow
screens/components that match the existing app. Source of truth is
`frontend/src/index.css` (tokens) + `frontend/src/components/ui/` (primitives).

**Stack:** React 19, Tailwind v4 (CSS-first `@theme`, no JS config), Radix primitives,
lucide-react icons, recharts. Dark mode via `data-theme` attribute flipping the same
token layer — never a separate dark stylesheet.

---

## 1. Brand & Voice

- **Signature color is oxblood** (`#9B2D3A`) — a deep wine red. It is the brand,
  money-out, and danger-adjacent color all at once. Restrained, serious, "money you
  respect."
- **Greyscale (zinc) is the workhorse.** Most surfaces, borders, and text are zinc.
  Color is used sparingly and meaningfully.
- **Money semantics are load-bearing:** green = money-in / positive, oxblood = money-out
  / negative. Never decorative.
- **Hero gradient** (`linear-gradient(135deg, #FF7847, #E84393)` — warm orange → pink) is
  the one moment of warmth: active nav, tree guides, skeleton shimmer, the dashboard
  "living" backdrop. Used at low opacity (11–24%), never as a flat fill.
- Links are **neutral** (foreground color + underline), never a blue hyperlink.

---

## 2. Color Tokens

All colors are CSS custom properties. Components NEVER hardcode hex — they reach through
the semantic layer (`--primary`, `--muted-foreground`, etc.). The raw ramps below feed
the semantic aliases.

### Raw ramps (light mode)

```
Zinc (greyscale workhorse)
  50 #FAFAFA · 100 #F4F4F5 · 200 #E4E4E7 · 300 #D4D4D8 · 400 #A1A1AA
  500 #71717A · 600 #52525B · 700 #3F3F46 · 800 #27272A · 900 #18181B · 950 #09090B

Oxblood (brand + money-out + danger)
  50 #FBEDEE · 100 #F6D6D9 · 200 #E9A8AF · 300 #DA7B85 · 400 #C44E5B
  500 #9B2D3A (PRIMARY) · 600 #82252F · 700 #661C26 · 800 #4A141B · 900 #2E0C10

Alert red (destructive ONLY — kept distinct from oxblood brand)
  200 #FECACA · 400 #F87171 · 600 #DC2626 · 700 #C81E1E

Green (money-in / positive)
  100 #D1FAE5 · 200 #7DDCAE · 300 #35BE83 · 500 #0FA06C · 600 #0A875D · 700 #086F4C

Amber (warning / caution ONLY — not a brand color)
  100 #FEF3C7 · 300 #F5C451 · 500 #D9A441 · 700 #B45309

Hero gradient   linear-gradient(135deg, #FF7847, #E84393)
Chart steel     #5EA8E0
```

### Semantic tokens — Light / Dark

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | zinc-100 `#F4F4F5` | `#0A0A0B` | page fill |
| `--card` | `#FFFFFF` | `#141416` | raised surfaces |
| `--popover` | `#FFFFFF` | `#1A1A1D` | floating menus |
| `--muted` | zinc-100 | `#1F1F22` | secondary/disabled areas |
| `--foreground` | zinc-900 | `#EDEDEF` | primary text |
| `--muted-foreground` | zinc-500 | `#8B8B90` | hint/secondary text |
| `--primary` | oxblood-500 | oxblood-500 | brand / CTA |
| `--primary-hover` | oxblood-600 | oxblood-400 | CTA hover |
| `--primary-foreground` | `#FFFFFF` | `#FBEDEE` | text on primary |
| `--accent` | oxblood-50 | oxblood-900 | subtle brand fill |
| `--accent-foreground` | oxblood-700 | oxblood-100 | text on accent |
| `--success` / `-bg` / `-foreground` | green-600 / green-100 / green-700 | green-300 / `#0E2A1E` / green-200 | positive states |
| `--warning` / `-bg` / `-foreground` | amber-700 / amber-100 / amber-700 | amber-300 / `#3A2C00` / amber-100 | caution |
| `--danger` / `-bg` / `-foreground` | alert-700 / `#FCEAEA` / alert-700 | alert-400 / `#3A1517` / alert-200 | alert messaging |
| `--info` / `-bg` / `-foreground` | `#1B6FA8` / `#E6F1FA` / `#0E456B` | steel / `#102A3F` / `#BFDCF5` | informational |
| `--positive` | green-600 | green-300 | money-in |
| `--negative` / `-bg` | oxblood-500 / oxblood-50 | oxblood-300 / `#2A1416` | money-out |
| `--destructive` / `-foreground` | alert-600 / `#FFFFFF` | alert-400 / `#1A0606` | delete actions |
| `--border` | zinc-200 | `#242427` | dividers/outlines |
| `--input` | zinc-300 | `#3A3A3E` | form field borders |
| `--ring` | oxblood-500 | oxblood-400 | focus ring |
| `--shadow` | `0 8px 18px rgb(9 9 11 / 0.08)` | `0 14px 28px rgb(0 0 0 / 0.45)` | card elevation |

**`--danger` vs `--destructive`:** both red. `--destructive` (alert-600) is for
destructive *action* buttons (delete). `--danger` (alert-700) is for alert *messaging*
(error banners). They're intentionally separate from oxblood so "brand red" and "stop
red" never get confused.

### Chart palette

Line series: `--chart-line-1..6` = primary, positive, steel, destructive, amber-300,
oxblood-300. Categorical avatars: 12 colors `--avatar-1..12` (`#5B8DEF`, `#7C5CFF`,
`#10B981`, `#F59E0B`, `#EF4444`, `#06B6D4`, `#EC4899`, `#84CC16`, `#0EA5E9`, `#A855F7`,
`#F97316`, `#14B8A6`) with precomputed contrast text. Money flow: `--chart-spend`
(oxblood), `--chart-credit` (green), `--chart-payment` (zinc), `--chart-business`
(steel), `--chart-personal` (green).

---

## 3. Typography

**Font stack:** `'Avenir Next', 'Segoe UI Variable Display', 'IBM Plex Sans', 'Segoe UI',
sans-serif`. Base line-height 1.45, weight 400, antialiased, `optimizeLegibility`.

**Scale** (Tailwind `text-*` tokens — `display-lg` → `body-sm`):

| Token | Size | Line height | Tracking |
|---|---|---|---|
| `text-display-lg` | 3.25rem | 3.5rem | -0.02em |
| `text-display` | 2.25rem | 2.5rem | -0.02em |
| `text-display-sm` | 2rem | 2rem | -0.02em |
| `text-headline-lg` | 1.875rem | 2.25rem | -0.01em |
| `text-headline` | 1.5rem | 1.75rem | -0.01em |
| `text-headline-sm` | 1rem | 1.25rem | 0 |
| `text-body-lg` | 1rem | 1.25rem | 0 |
| `text-body` (default) | 0.875rem | 1.0625rem | 0 |
| `text-body-sm` | 0.75rem | 0.9375rem | 0 |

**In practice (page chrome):**
- `h1` (page title): `text-[1.55rem] font-semibold tracking-tight sm:text-[1.8rem]`
- `h2` (section): `text-[1.05rem] font-semibold tracking-tight`
- Body default: `text-sm` (0.875rem)
- Labels/captions: `text-[0.72rem] font-semibold uppercase tracking-normal text-muted-foreground`
- Hint/muted: `text-sm text-muted-foreground`

---

## 4. Spacing, Radius, Layout

- **Spacing:** Tailwind default scale, no overrides. Common rhythm — cards `mb-4`, header
  rows `gap-3`, grids `gap-3`/`gap-4`, form labels `gap-1`, list rows `py-0.5 gap-1.5`.
- **Radius:** base `--radius: 0.5rem`. `rounded-sm` 2px · `rounded-md` 4px · `rounded-lg`
  8px (default for cards/buttons) · `rounded-xl` 12px.
- **Breakpoints:** Tailwind defaults + custom `3xl` = 90rem (1440px) for dense 4-wide
  bento tiers.
- **App shell:** two-column grid — 240px sticky sidebar (brand / nav / footer) + main
  column. Sidebar collapses to an off-canvas drawer at ≤768px. Main content max-width
  `80rem` default (`110rem` wide, `160rem` ultrawide via `data-layout-width`), padded
  `px-4 sm:px-6 lg:px-8 py-5`.
- **Touch targets:** `touch-hitbox` utility guarantees 44×44px tap area on icon buttons.

---

## 5. Component Primitives

Located in `frontend/src/components/ui/`. Built with **CVA** (class-variance-authority)
for variant props + `cn()` (clsx) merging. Every primitive carries a
`data-slot="<name>"` attribute. Class strings are verbatim so you can reproduce the look.

### Button — `button.tsx`
- **variant:** `default` · `primary` · `secondary` · `outline` · `ghost` · `destructive`
  · `danger` · `link`
- **size:** `default` (h-10 px-4) · `sm` (px-3 text-sm) · `lg` (h-11 px-8) · `icon` (h-10 w-10)
- Base: `inline-flex items-center justify-center whitespace-nowrap rounded-lg font-semibold transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50`
- default/primary: `bg-button-primary text-text-button-primary hover:bg-button-hover-primary`
- secondary: `border border-border bg-card text-foreground hover:bg-muted`
- destructive: tinted fill `bg-button-destructive border border-destructive text-destructive`
- link: `text-text-link underline-offset-4 hover:underline`
- Supports `asChild` (Radix Slot) for rendering as a link, etc.

### Badge — `badge.tsx`
variant: `default` (brand fill) · `secondary` · `destructive` · `outline` · `count`
(uppercase pill for counters). Base: `inline-flex w-fit rounded-md border px-2 py-0.5 text-xs font-medium`.

### Card — `card.tsx`
`rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm sm:p-5`.
Sub-parts: `CardHeader` (grid gap-1.5 px-5 pt-5), `CardTitle` (font-semibold tracking-tight),
`CardDescription` (text-sm text-muted-foreground), `CardContent` (px-5 py-5).

### Input / Textarea / NativeSelect / Label
- Input: `h-9 w-full rounded-md border border-input bg-background/70 px-3 text-sm shadow-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive`
- Textarea: same treatment, `min-h-16 py-2`.
- NativeSelect: `min-h-9 rounded-md border border-input bg-background/70 px-3 text-sm` (+ `sm` size).
- Label: `grid gap-1 text-[0.82rem] font-semibold text-muted-foreground` (label sits above field).

### Alert — `alert.tsx`
variant: `error` · `warning` · `info` · `success`. Base: `flex flex-col gap-2 rounded-lg
border p-3 text-sm`. Each variant = `color-mix` of its semantic color into bg (~10–12%)
and border (~42–45%). `error` → `role="alert" aria-live="assertive"`; others →
`role="status" aria-live="polite"`.

### Table — `table.tsx`
Overflow wrapper with optional `maxHeight` + `stickyHeader`. Row:
`border-b border-border hover:bg-muted/45 data-[state=selected]:bg-muted`. Head:
`h-10 px-3 text-left text-xs font-semibold uppercase text-muted-foreground`. Cell:
`px-3 py-2.5 align-middle`.

### Tabs — `tabs.tsx`
Pill tablist: `inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted/30 p-1`.
Active tab: `bg-card text-foreground shadow-sm`; inactive: `text-muted-foreground
hover:text-foreground`. Full keyboard nav (arrows/home/end), `aria-selected`.

### Skeleton — `skeleton.tsx`
`skeleton-shimmer rounded-md` — 1.6s hero-gradient sweep at 22% opacity over muted base;
respects `prefers-reduced-motion`. Helpers: `SkeletonText` (N lines, last 2/3 width),
`SkeletonRow` (N table cells).

### EmptyState — `empty-state.tsx`
`rounded-lg border border-border bg-muted/20 p-4 text-sm` with muted title + description +
actions row. `EmptyTableRow` wraps it in a full-width `<tr>`.

### Headers — `page-header.tsx` / `section-header.tsx`
Both: `mb-4 flex flex-wrap items-start justify-between gap-3` with title + optional
description + right-aligned actions slot. PageHeader = `h1`, SectionHeader = `h2`.

### Metrics — `stat-card.tsx`, `metric-stat.tsx`, `DeltaBadge.tsx`, `pct-delta-cell.tsx`
- **StatCard:** Card with uppercase label, large value (`text-[1.55rem] font-bold
  tracking-tight`), hint, and a signed delta.
- **DeltaBadge / delta tone:** tone resolves from `sign × metricKind`. `metricKind="gain"`
  → up is green; `metricKind="spend"` → up is *bad* (inverted); `neutral` → always muted.
  Arrows ▲ ▼ —. This is the core "is this number good?" logic — match it.
- **Sparkline:** minimal recharts line; green if trending up, oxblood if down.

### Containers & nav — `collapsible-card.tsx`, `grid.tsx`, `tree.tsx`, `filter-bar.tsx`, `filter-card.tsx`
- **CollapsibleCard:** card with a clickable header that expands/collapses (aria-expanded).
- **Grid:** responsive auto-fit/auto-fill grid; `minItemWidth` + gap `sm`/`md`/`lg`.
- **Tree:** nested rows with hero-gradient indent guides, drag grip, hover-revealed actions,
  trailing slot for amounts.
- **FilterBar:** currency + date-from/to + quick-range toggle buttons (`aria-pressed`).
- **FilterCard:** filter wrapper, `comfortable` (default) or `compact` density.

### Avatar — `letter-avatar.tsx`
Categorical avatar from a hashed first character → one of the 12 `--avatar-*` colors with
precomputed contrast text. Sizes `sm` 24 · `md` 32 · `lg` 48 · `xl` 64px.

---

## 6. Icons & Motion

- **Icons:** lucide-react, stroke-based. Size via `size={px}` or `h-4 w-4 shrink-0`.
  Hero-gradient stroke applied by injecting an SVG `<linearGradient>` for accent moments.
- **Motion:** transitions 150–700ms. Skeleton shimmer (1.6s). Dashboard-only "living
  gradient" backdrop — two drifting radial hero gradients at low opacity, 24s loop, faded
  in only on the dashboard. All motion respects `prefers-reduced-motion`.

---

## 7. Rules When Designing New Cashflow UI

1. **Reach for a primitive first.** Button, Card, Table, StatCard, Alert, EmptyState,
   Tabs cover most screens. Compose, don't reinvent.
2. **Use semantic tokens, never raw hex.** `bg-card`, `text-muted-foreground`,
   `border-border`, `text-positive`. This is what makes dark mode free.
3. **Respect money semantics.** Green = in/gain, oxblood = out/loss. Use the delta-tone
   logic (`gain` vs `spend`) so "up" reads correctly per metric.
4. **Oxblood is precious.** Brand/CTA/primary only. Don't paint surfaces with it.
5. **Greyscale by default.** Zinc surfaces, zinc text, color only where it carries meaning.
6. **Cards `rounded-lg`, subtle `shadow-sm`, `border-border`.** Keep elevation light.
7. **Every interactive element gets a visible focus ring** (`ring-ring`) and ≥44px touch
   target.
8. **Provide loading (Skeleton), empty (EmptyState), and error (Alert) states** for any
   data view — they are first-class, not afterthoughts.
9. **Page = PageHeader + cards/sections.** Section = SectionHeader + content. Consistent
   `mb-4` rhythm.

---

## 8. Copyable Token Block

Drop this into any prototype (Tailwind v4 `@theme` or plain CSS) to get the exact palette.

```css
:root, :root[data-theme="light"] {
  --radius: 0.5rem;
  /* zinc */
  --zinc-50:#FAFAFA; --zinc-100:#F4F4F5; --zinc-200:#E4E4E7; --zinc-300:#D4D4D8;
  --zinc-400:#A1A1AA; --zinc-500:#71717A; --zinc-600:#52525B; --zinc-700:#3F3F46;
  --zinc-800:#27272A; --zinc-900:#18181B; --zinc-950:#09090B;
  /* oxblood */
  --oxblood-50:#FBEDEE; --oxblood-100:#F6D6D9; --oxblood-200:#E9A8AF; --oxblood-300:#DA7B85;
  --oxblood-400:#C44E5B; --oxblood-500:#9B2D3A; --oxblood-600:#82252F; --oxblood-700:#661C26;
  --oxblood-800:#4A141B; --oxblood-900:#2E0C10;
  /* alert / green / amber */
  --alert-200:#FECACA; --alert-400:#F87171; --alert-600:#DC2626; --alert-700:#C81E1E;
  --green-100:#D1FAE5; --green-200:#7DDCAE; --green-300:#35BE83; --green-500:#0FA06C;
  --green-600:#0A875D; --green-700:#086F4C;
  --amber-w-100:#FEF3C7; --amber-w-300:#F5C451; --amber-w-500:#D9A441; --amber-w-700:#B45309;
  --gradient-hero: linear-gradient(135deg,#FF7847,#E84393);
  --chart-steel:#5EA8E0;
  /* semantic */
  --background:var(--zinc-100); --card:#FFFFFF; --popover:#FFFFFF; --muted:var(--zinc-100);
  --foreground:var(--zinc-900); --muted-foreground:var(--zinc-500);
  --primary:var(--oxblood-500); --primary-hover:var(--oxblood-600); --primary-foreground:#FFFFFF;
  --accent:var(--oxblood-50); --accent-foreground:var(--oxblood-700);
  --success:var(--green-600); --success-bg:var(--green-100); --success-foreground:var(--green-700);
  --warning:var(--amber-w-700); --warning-bg:var(--amber-w-100); --warning-foreground:var(--amber-w-700);
  --danger:var(--alert-700); --danger-bg:#FCEAEA; --danger-foreground:var(--alert-700);
  --info:#1B6FA8; --info-bg:#E6F1FA; --info-foreground:#0E456B;
  --positive:var(--green-600); --negative:var(--oxblood-500); --negative-bg:var(--oxblood-50);
  --destructive:var(--alert-600); --destructive-foreground:#FFFFFF;
  --border:var(--zinc-200); --input:var(--zinc-300); --ring:var(--oxblood-500);
  --shadow:0 8px 18px rgb(9 9 11 / 0.08);
}
:root[data-theme="dark"] {
  --background:#0A0A0B; --card:#141416; --popover:#1A1A1D; --muted:#1F1F22;
  --foreground:#EDEDEF; --muted-foreground:#8B8B90;
  --primary:var(--oxblood-500); --primary-hover:var(--oxblood-400); --primary-foreground:#FBEDEE;
  --accent:var(--oxblood-900); --accent-foreground:var(--oxblood-100);
  --success:var(--green-300); --success-bg:#0E2A1E; --success-foreground:var(--green-200);
  --warning:var(--amber-w-300); --warning-bg:#3A2C00; --warning-foreground:var(--amber-w-100);
  --danger:var(--alert-400); --danger-bg:#3A1517; --danger-foreground:var(--alert-200);
  --info:var(--chart-steel); --info-bg:#102A3F; --info-foreground:#BFDCF5;
  --positive:var(--green-300); --negative:var(--oxblood-300); --negative-bg:#2A1416;
  --destructive:var(--alert-400); --destructive-foreground:#1A0606;
  --border:#242427; --input:#3A3A3E; --ring:var(--oxblood-400);
  --shadow:0 14px 28px rgb(0 0 0 / 0.45);
}
```
