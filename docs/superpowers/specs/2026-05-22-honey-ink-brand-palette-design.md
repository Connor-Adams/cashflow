# Honey & Ink — brand palette, dashboard bento, light-mode fix

**Date:** 2026-05-22
**Status:** approved (brainstorming), pending implementation plan
**Scope:** one PR. Touches `frontend/src/index.css`, `frontend/src/App.css`, `frontend/src/pages/DashboardPage.tsx`, and adds three new components under `frontend/src/components/dashboard/`. Other pages auto-inherit the new palette through tokens.

---

## Goals

1. Collapse the two conflicting color systems into one source of truth.
2. Establish a coherent "Honey & Ink" brand palette — warm and personal, not corporate fintech.
3. Make light mode first-class (full parity with dark).
4. Restructure the dashboard into a bento grid for at-a-glance hierarchy, with drill-down tables below.

## Non-goals

- No new data fetching, no API changes.
- No Recharts replacement.
- No dashboard customization (drag/resize/persisted layout).
- No table redesign beyond inherited token swaps.
- No typography or radius scale changes — both already live in `index.css` `@theme inline` and are out of scope.

---

## Root-cause context: the two-system conflict

`frontend/src/index.css` `:root` defines oklch-based green tokens consumed by Tailwind's `@theme inline` block. `frontend/src/App.css` defines `:root[data-theme="dark"]` and `:root[data-theme="light"]` with hex-based blue tokens. ThemeProvider toggles the `data-theme` attribute.

The two blocks redefine the same custom-property names (`--primary`, `--background`, `--card`, etc.) with different colors. Result:

- Tailwind utilities (`text-primary`, `bg-card`) read from `index.css` → always green-tinted dark.
- Legacy `var(--primary)` consumers in App.css component classes (`.navLink.isActive`, `.brandMark`, etc.) → blue-tinted, overridden by `data-theme` block.
- Light mode "works" only for legacy consumers. Tailwind-themed surfaces stay dark in light mode because `index.css` has no light variant.
- Body background is a hardcoded dark gradient (`#12170f` → `#0b0d0b`) in `index.css` that is not theme-scoped — light mode keeps a near-black background.
- Chart colors are hardcoded hex literals (`#94a3b8`, `#f59e0b`, `#22c55e`, etc.) in `DashboardPage.tsx` — never theme.

The user-perceived symptoms ("palette is boring", "light mode is kinda broken") trace to this collision plus the muted sage-green tokens.

---

## Section 1 — Token system architecture

One source of truth, two modes, no fallback layer.

### Structural rules

1. **All token definitions live in `index.css`.** App.css owns component classes, not tokens.
2. **Default `:root` is light mode.** Renders correctly on first paint before JS sets `data-theme`.
3. **Each anchor color has a "surface" form and a "foreground" form.** E.g. amber-as-button-fill vs. amber-as-text-on-pale-amber. Lightness flips between modes; hue stays constant.
4. **`color-scheme` is mode-driven** — `dark` or `light` per `data-theme` — so native scrollbars and form controls match.
5. **Legacy aliases** (`--bg`, `--bg2`, `--bg3`, `--fg`, `--muted-legacy`, `--accent-soft`, `--accent-warm`, `--accent-green`, `--danger`) stay for one migration cycle as thin aliases over canonical tokens. They get removed in a follow-up sweep after `grep` confirms zero remaining consumers.
6. **Chart colors are tokens** (`--chart-spend`, `--chart-credit`, `--chart-payment`, `--chart-business`, `--chart-personal`, plus a 6-step ordinal currency-line palette).

### Body background

Replace the hardcoded gradient with token-driven layers:

```css
body {
  background:
    radial-gradient(circle at 20% -10%,
      color-mix(in oklch, var(--primary) 12%, transparent),
      transparent 30rem),
    var(--background);
}
```

The radial accent gives a subtle warm glow at the top-left in both modes — amber bleed in dark, faint amber wash in light.

### Trade-off

Because the existing App.css `data-theme` blocks define `--primary` etc., touching them changes color for every component currently styled with `var(--primary)`. The token rework and the palette change are the same change — they cannot ship separately.

---

## Section 2 — Honey & Ink palette

### Anchors (unchanged across modes)

| Token | oklch | Role |
|---|---|---|
| amber | `oklch(0.72 0.14 80)` | brand primary |
| plum | `oklch(0.32 0.08 350)` | accent (deep form) |
| jade | `oklch(0.62 0.11 155)` | positive / credit / gain |
| rust | `oklch(0.58 0.16 30)` | alert / destructive / spend |
| ink | `oklch(0.16 0.01 280)` | surface dark |
| bone | `oklch(0.97 0.005 90)` | surface light |

### Dark mode tokens

```css
:root[data-theme="dark"] {
  --background:       oklch(0.16 0.01 280);   /* ink */
  --card:             oklch(0.20 0.012 280);
  --popover:          oklch(0.22 0.012 280);
  --muted:            oklch(0.23 0.012 280);

  --foreground:       oklch(0.96 0.005 90);   /* warm bone-white text */
  --muted-foreground: oklch(0.72 0.015 80);

  --primary:                oklch(0.72 0.14 80);
  --primary-foreground:     oklch(0.16 0.01 280);

  --accent:                 oklch(0.32 0.08 350);
  --accent-foreground:      oklch(0.96 0.005 90);

  --positive:               oklch(0.62 0.11 155);
  --positive-foreground:    oklch(0.16 0.01 280);
  --destructive:            oklch(0.58 0.16 30);
  --destructive-foreground: oklch(0.96 0.005 90);

  --border:           oklch(0.30 0.012 280);
  --input:            oklch(0.34 0.012 280);
  --ring:             oklch(0.72 0.14 80);

  --shadow:           0 14px 28px oklch(0 0 0 / 0.45);
  color-scheme: dark;
}
```

### Light mode tokens

```css
:root, :root[data-theme="light"] {
  --background:       oklch(0.97 0.005 90);   /* bone */
  --card:             oklch(1.00 0 0);
  --popover:          oklch(1.00 0 0);
  --muted:            oklch(0.94 0.006 85);

  --foreground:       oklch(0.20 0.01 280);
  --muted-foreground: oklch(0.45 0.015 80);

  --primary:                oklch(0.68 0.16 78);   /* darker amber for weight on bone */
  --primary-foreground:     oklch(0.20 0.01 280);

  --accent:                 oklch(0.92 0.04 350);  /* pale plum surface */
  --accent-foreground:      oklch(0.32 0.08 350);  /* deep plum text */

  --positive:               oklch(0.52 0.13 155);
  --positive-foreground:    oklch(0.97 0.005 90);
  --destructive:            oklch(0.52 0.18 30);
  --destructive-foreground: oklch(0.97 0.005 90);

  --border:           oklch(0.88 0.008 85);
  --input:            oklch(0.82 0.01 85);
  --ring:             oklch(0.68 0.16 78);

  --shadow:           0 8px 18px oklch(0.20 0.01 280 / 0.10);
  color-scheme: light;
}
```

### Chart tokens

```css
/* dark mode */
--chart-spend:    var(--primary);            /* amber */
--chart-credit:   var(--positive);           /* jade */
--chart-payment:  oklch(0.65 0.02 250);      /* cool steel — visually inert */
--chart-business: oklch(0.65 0.10 350);      /* lifted plum, readable on ink */
--chart-personal: var(--positive);           /* jade */

/* light mode overrides */
--chart-payment:  oklch(0.55 0.02 250);
--chart-business: oklch(0.42 0.10 350);      /* deeper plum on bone */
```

Ordinal currency-line palette (replaces the hardcoded `LINE_COLORS` array):

```css
--chart-line-1: var(--primary);           /* amber */
--chart-line-2: var(--positive);          /* jade */
--chart-line-3: var(--chart-business);    /* plum */
--chart-line-4: var(--destructive);       /* rust */
--chart-line-5: oklch(0.65 0.02 250);     /* steel */
--chart-line-6: oklch(0.55 0.08 320);     /* mauve */
```

### Legacy aliases (one migration cycle)

```css
--bg:           var(--background);
--bg2:          var(--card);
--bg3:          var(--muted);
--fg:           var(--foreground);
--muted-legacy: var(--muted-foreground);
--accent-soft:  var(--accent);
--accent-warm:  var(--primary);
--accent-green: var(--positive);
--danger:       var(--destructive);
```

### Design rationale

- **Amber shifts hue 80 → 78 and lightness 0.72 → 0.68 in light mode** for AA contrast on bone (3:1 for UI components). Pure 0.72 amber on bone reads as washed-out.
- **Plum splits into surface and text forms.** Deep plum (0.32) as a surface in light mode would be brutally heavy. Pale plum (0.92) becomes the accent surface; deep plum (0.32) becomes the text color on that surface. Dark mode mirrors: deep plum surface, bone text.
- **`--card` is pure white in light mode**, not bone. Bone is the canvas; cards lift slightly off it. Bento tiles get a visible edge without heavy borders or shadows.
- **`--positive` / `--destructive` darken in light mode** for AA contrast on bone (4.5:1 for text).
- **Business gets plum, personal gets jade.** Plum is the formal/serious hue; jade is warmer/everyday. Preserves the current green-as-personal mapping and gives business a more distinctive identity than "second orange next to amber primary".

---

## Section 3 — Dashboard bento layout

### Governing decisions

1. **Bento is for at-a-glance. Tables stay below.** Tables don't compress into tiles without becoming useless. The four current tables (Category report, Merchant report, Account report, Review queue) stay full-width-stacked below the bento.
2. **Cut the duplicates.**
   - **"Net spend by business flag" bar chart → cut.** Pure duplicate of the Business vs personal spotlight.
   - **7 StatCards → 1 hero tile + 1 KPI stack.** Net spend is the headline; spend / credits / payments become text rows inside the hero tile. Transactions / Merchants / Accounts become the small KPI stack.
3. **Grid: 12 cols wide, 6 cols tablet (≤1023px), 1 col mobile (≤639px).**

### Layout

```
Filters bar (full width)
Review alert (full width, conditional)
─────────────────────────────────────────────
Bento:
  Row 1: [ Hero 8×2 ]                [ KPI stack 4×2 ]
  Row 2: [ Business vs personal 6×2] [ Monthly flow 6×2 ]
  Row 3: [ Top categories 8×2 ]      [ AI insights 4×2 ]
  Row 4: [ Activity by month 12×2 ]
─────────────────────────────────────────────
Category report table (full width)
Merchant report table (full width)
Account report table (full width)
Review queue table (full width)
```

### Tile spec

| Tile | Span | Source today | Change |
|---|---|---|---|
| Hero — This period | 8×2 | StatCards: Net spend, Spend, Credits, Payments + sparkline derived from `monthlyBreakdownData` | New composite component `HeroTile`. Promotes net spend; sub-metrics become text rows. |
| KPI stack | 4×2 | StatCards: Transactions, Merchants, Accounts | New component `KpiStack`. Vertical stack, smaller. Transactions on top (has delta), others below. |
| Business vs personal | 6×2 | `dashboardBusinessSpotlight` section | Reframed as grid child with new tile chrome. Internal JSX unchanged. |
| Monthly flow | 6×2 | `Monthly breakdown` bar chart | Smaller plot area, tighter margins. |
| Top categories | 8×2 | `Net spend by category` bar chart + "Jump to transactions" link row | Wider so labels don't crowd. Drill-click preserved. |
| AI insights | 4×2 | `aiVisibilityList` | Tile always renders. Empty state: "No insights for {period}" instead of disappearing. |
| Activity by month | 12×2 | Multi-currency line chart | Full-width — comparison across currencies needs horizontal real estate. Uses ordinal `--chart-line-N` tokens. |

### Tile chrome

```css
.bentoTile {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 100%;
}
.bentoTile--hero {
  background:
    linear-gradient(180deg,
      color-mix(in oklch, var(--primary) 8%, transparent),
      transparent 24%),
    var(--card);
}
.bentoTile__label {
  font-size: var(--text-body-sm);
  color: var(--muted-foreground);
}
.bentoTile__value {
  font-size: var(--text-display-sm);
  font-weight: 600;
}
```

### Grid container

```css
.dashboardBento {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-auto-rows: 132px;
  gap: 16px;
}
.bentoTile[data-span="3"]  { grid-column: span 3; }
.bentoTile[data-span="4"]  { grid-column: span 4; }
.bentoTile[data-span="6"]  { grid-column: span 6; }
.bentoTile[data-span="8"]  { grid-column: span 8; }
.bentoTile[data-span="12"] { grid-column: span 12; }
.bentoTile[data-rows="2"]  { grid-row: span 2; }

@media (max-width: 1023px) {
  .dashboardBento { grid-template-columns: repeat(6, 1fr); }
  .bentoTile[data-span="8"], .bentoTile[data-span="12"] { grid-column: span 6; }
  .bentoTile[data-span="4"] { grid-column: span 3; }
}
@media (max-width: 639px) {
  .dashboardBento { grid-template-columns: 1fr; grid-auto-rows: auto; }
  .bentoTile { grid-column: 1 / -1 !important; grid-row: auto !important; }
}
```

### DashboardPage changes

- New `HeroTile` consumes `summaryStats` + a slice of `monthlyBreakdownData` for the sparkline.
- Seven `<StatCard>` calls collapse → net spend / spend / credits / payments fold into `HeroTile`; transactions / merchants / accounts become `<KpiStack>`.
- `<section className="card dashboardBusinessSpotlight">` becomes `<BentoTile span={6} rows={2}>` wrapping the same internal JSX.
- Each surviving chart `<section>` becomes a `<BentoTile>`.
- Tables stay in full-width sections below the bento. Cosmetic rename: `.dashboardChartCard` → `.dashboardTableCard` so bento and tables have clearly separate chrome.
- Hardcoded chart colors swap to tokens:
  - `'var(--primary)'` → `'var(--chart-spend)'`
  - `'#22c55e'` → `'var(--chart-credit)'`
  - `'#94a3b8'` → `'var(--chart-payment)'`
  - `BUSINESS_COLOR` constant → `'var(--chart-business)'`
  - `PERSONAL_COLOR` constant → `'var(--chart-personal)'`
  - `LINE_COLORS` array → references to `var(--chart-line-1..6)`

---

## Section 4 — Migration

### Strategy

One PR. Splitting palette and bento means the intermediate state is "amber stacked dashboard," visibly worse than either end state. This is a personal app; atomic is fine.

### Order within the PR

1. **Token consolidation.** Delete `:root[data-theme]` blocks from `App.css`. Rewrite `index.css` `:root` with new dual-mode tokens. Add legacy aliases.
2. **Body + global pieces.** Replace hardcoded body gradient with token-driven layers. Replace hardcoded `::selection` color with `color-mix(in oklch, var(--accent) 30%, transparent)`. Set Recharts `CartesianGrid stroke="var(--border)"` and tooltip styles to `var(--popover)` / `var(--popover-foreground)`.
3. **Chart tokens.** Add `--chart-*` tokens to both mode blocks. Replace every hex literal and `var(--primary)` in `DashboardPage.tsx` chart code.
4. **New bento components.** `frontend/src/components/dashboard/BentoTile.tsx`, `HeroTile.tsx`, `KpiStack.tsx`. CSS for `.dashboardBento` and `.bentoTile` in App.css.
5. **DashboardPage refactor.** Wrap surviving sections in `<BentoTile>`. Replace seven `<StatCard>` calls with `<HeroTile>` + `<KpiStack>`. Delete the "Net spend by business flag" section. Make AI insights always-render with an empty state.

### Compatibility surface

- **Component APIs unchanged.** `StatCard`, `FilterBar`, `PageHeader`, `Card`, `Alert`, `Button`, `Table` — all keep their props. They render in new colors because the tokens they reference changed.
- **Other pages (Transactions, Accounts, Review, Portfolio, Amazon, Recurring, Rules, Reports, Settings) auto-inherit the new palette** through tokens. No edits needed in this PR.
- **Legacy aliases stay for one PR cycle.** A follow-up sweep removes them after `grep` confirms zero references.

### Cleanups pulled in

- Hardcoded `'rgba(11, 16, 22, 0.96)'` tooltip background in `CHART_TOOLTIP_STYLE` → `var(--popover)`.
- Hardcoded `'#eef3f8'` tooltip text → `var(--popover-foreground)`.
- Recharts `Bar cursor` fill: set `cursor={{ fill: 'color-mix(in oklch, var(--accent) 30%, transparent)' }}` to avoid white-on-white hover in light mode.
- `BUSINESS_COLOR` / `PERSONAL_COLOR` / `LINE_COLORS` module constants → deleted in favor of `var(--chart-*)` references.

### Risks

- **`frontend/src/components/ui/stat-card.tsx` may have hardcoded green/red** for `metricKind` coloring. Verify during implementation; if present, swap to `var(--positive)` / `var(--destructive)`.
- **Hardcoded `--shadow` in `index.css`** must move to the new token blocks (already specified in Section 2).
- **First-paint flash.** ThemeProvider sets `data-theme` in `useEffect`, so for one frame the page renders with default `:root` (light). Existing behavior, not made worse by this PR. A blocking `<script>` in `index.html` reading localStorage before React mounts would eliminate it — separate fix, flagged as follow-up.

### Verification

- Theme toggle flips every visible surface (body, header, cards, charts, tooltips, scrollbars).
- AA contrast spot-check in light mode: `--primary` on `--card`, `--primary-foreground` on `--primary`, `--foreground` on `--card`, `--muted-foreground` on `--card`, `--positive` on `--card`, `--destructive` on `--card`.
- Dashboard at 1440 / 1024 / 768 / 375 px — bento collapses correctly at each breakpoint.
- DevTools spot-check: no hex literals appear in computed chart styles.

---

## Open follow-ups (not in this PR)

- Remove legacy `--bg`, `--bg2`, `--bg3`, `--fg`, `--accent-soft`, `--accent-warm`, `--accent-green`, `--danger`, `--muted-legacy` aliases once `grep` confirms zero consumers.
- Blocking pre-mount `<script>` in `index.html` to eliminate the first-paint theme flash.
- Audit other pages (Transactions, Accounts, Review, Portfolio, Amazon, Recurring, Rules, Reports, Settings) for inherited issues from the new palette — any page may surface contrast problems the dashboard didn't.
