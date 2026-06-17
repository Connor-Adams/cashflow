# UI Primitive Audit — 2026-06-17

Inventory of `frontend/src/components/ui/` as the grounding reference for the
UI Foundation rules doc (Task 2) and component gallery (Task 3).

## Consumer-count methodology

Counts were produced by grepping `frontend/src/` for the import-path substring
`components/ui/<basename>'` (single-quote-terminated to match both
`@/components/ui/foo'` and `../components/ui/foo'` patterns). The source file
itself is excluded. Run from `frontend/src/`:

```bash
for f in components/ui/*.tsx; do
  [ "${f%.test.tsx}" != "$f" ] && continue
  base=$(basename "$f" .tsx)
  n=$(grep -rl "components/ui/$base'" --include=*.tsx . | grep -v "$f" | wc -l | tr -d ' ')
  echo "$base : $n consumers"
done | sort -t: -k2 -rn
```

---

## Primitive inventory

> Status key — **solid**: clean Tailwind tokens, no App.css leaks, consistent
> prop surface; **inconsistent**: minor drift (inline styles, legacy class refs,
> duplicated padding, or undefined tokens); **gap**: structural/layout need not
> yet met by any primitive.

| primitive | consumers | variants / props | status |
|---|---|---|---|
| `button` | 126 | `variant` (default/primary/secondary/outline/ghost/destructive/danger/link), `size` (default/sm/lg/icon), `asChild` | solid |
| `card` | 80 | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent` — all className-passthrough | inconsistent — `Card` (`p-4 sm:p-5`) + `CardContent` (`px-5 py-5`) double-pad when composed (see Known Leaks §2) |
| `toast` | 60 | `ToastProvider`, `useToast`; variants: default/success/warning/destructive; `title`, `description`, `action`, `durationMs` | inconsistent — inline `style` objects for variant theming (`variantStyle()`) instead of Tailwind tokens; uses raw `var(--fg)`, `var(--bg2)`, `var(--card)` |
| `table` | 46 | `Table`, `TableHeader`, `TableBody`, `TableHead`, `TableRow`, `TableCell` | solid |
| `page-header` | 43 | `title`, `description`, `actions`, `children`; renders `<section>` | inconsistent — `description` slot uses raw `.muted` App.css class (`<p className="muted mb-0">`) |
| `badge` | 42 | `variant` (default/secondary/destructive/outline) | solid |
| `empty-state` | 39 | `title`, `description`, `actions`; `EmptyTableRow` companion | inconsistent — leaks `.emptyState` / `.muted` App.css classes (see Known Leaks §2) |
| `input` | 36 | className-passthrough `<input>`; no size variant | solid |
| `dialog` | 33 | `Dialog`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogBody`, `DialogFooter`, `useConfirm`; `dismissOnBackdropClick`, `initialFocusRef` | inconsistent — inline `style={{ background: 'var(--card)', color: 'var(--fg)' }}` on the panel; `DialogDescription` uses inline style for muted color |
| `native-select` | 29 | `size` (default/sm); `NativeSelect` + `NativeSelectOption` | solid |
| `label` | 27 | className-passthrough `<label>` with grid layout baked in | solid |
| `skeleton` | 18 | `Skeleton`, `SkeletonText` (lines prop), `SkeletonRow` (cols prop) | solid |
| `stat-card` | 12 | `label`, `value`, `hint`, `delta`, `metricKind` (gain/spend/neutral) | inconsistent — leaks `.statLabel` / `.statValue` / `.statHint` / `.muted` App.css classes (see Known Leaks §1) |
| `tabs` | 10 | `Tabs` (controlled: `items`, `value`, `onValueChange`), `TabPanel` | solid |
| `collapsible-card` | 9 | `title`, `description`, `actions`, `defaultOpen`, `toggleLabel` | inconsistent — root uses `.card` App.css class; header uses `.reportsCardHeader` App.css class |
| `textarea` | 8 | className-passthrough `<textarea>` mirroring Input | solid |
| `alert` | 6 | `variant` (error/warning/info/success), `title`, `action`; inline `VARIANT_STYLE` table | inconsistent — theming via inline `style` object (`VARIANT_STYLE`) rather than Tailwind tokens |
| `filter-bar` | 5 | `currency`, `dateFrom`, `dateTo`, `quickRanges`, `availableCurrencies`, `allowAllCurrencies`, `actions`, `caption` | inconsistent — inner row uses `.row` App.css class; quick-range container uses `.quickFilters` + `.quickFilterButton` App.css classes |
| `security-logo` | 2 | `symbol`, `name`, `size` (sm/md/lg/xl), `assetType`, `currency`; falls back to `LetterAvatar` | inconsistent — inline style object for all sizing/shape (hard-coded `backgroundColor: '#FFFFFF'`) |
| `metric-stat` | 2 | `label`, `value`, `delta`, `deltaPct`, `hint`, `loading` | inconsistent — references undefined token `--accent-positive`; inline `style={{ borderLeft }}` (see Known Leaks §3) |
| `allocation-donut` | 2 | `title`, `slices`, `wrapInCard` (bool) | inconsistent — uses `.transactionsPanelHeader` App.css class; inline `style={{ width, height }}` |
| `sparkline` | 1 | `data` (SparklinePoint[]), `width`, `height` | inconsistent — references undefined token `--accent-positive` (same dead-token as metric-stat/pct-delta-cell) |
| `pct-delta-cell` | 1 | `value: number \| null` | inconsistent — references undefined token `--accent-positive`; pure inline style |
| `letter-avatar` | 1 | `text`, `size` (sm/md/lg/xl) | inconsistent — all styling via inline `style` object; hard-coded hex PALETTE |
| `DeltaBadge` | 1 | `delta`, `metricKind`, `currency`, `className` | solid — uses `DELTA_SIGN_STYLE` from `delta-tone.ts` (canonical token map) |

**Non-primitive helper modules** (excluded from the table above):

- `delta-tone.ts` — pure utility; exports `MetricKind`, `DeltaSign`, `DeltaTone`, `parseDeltaSign`, `resolveDeltaTone`, `DELTA_SIGN_STYLE`. No JSX.
- `toast-context.ts` — React context + type definitions for the toast system. No JSX.
- `localPrimitives.test.tsx` — test file.

---

## Known internal leaks

These are confirmed findings to be remediated by a later hardening sub-project.
**Do not fix here.**

### 1. `stat-card.tsx:33-38` — raw App.css class leak

`StatCard` renders `.statLabel`, `.statValue`, `.statHint`, and `.muted` as bare
className strings. All four are defined in `App.css` (lines 1246, 1251, 1255,
284). The primitive couples itself to the global stylesheet instead of Tailwind
tokens.

```tsx
<p className="statLabel">{label}</p>
<p className={cn('statValue', 'text-xl font-semibold truncate')} ...>
<p className={cn('muted statHint', 'text-xs')}>{hint}</p>
```

### 2. `empty-state.tsx:17-18` — raw App.css class leak

`EmptyState` renders `.emptyState` and `.muted` as bare className strings
(App.css lines 1390, 284). `EmptyTableRow` adds `.emptyStateCell` (App.css
line 1395).

```tsx
<p className="emptyState mb-1 font-semibold">{title}</p>
{description ? <p className="muted mb-0">{description}</p> : null}
```

### 3. `metric-stat.tsx:17,43` — undefined token + inline border

`metric-stat.tsx` references `var(--accent-positive)` (line 17 of
`formatDelta`, surface at lines 23 and 43), a token that **does not exist** in
`index.css`. Only `--accent-warm` (line 162) and `--accent-green` (line 163)
are defined. The positive branch of `formatDelta` therefore renders as `unset`
(transparent/inherited), producing a dead/invisible color for positive deltas.

Additionally, line 43 applies a left-border accent via `style={{ borderLeft }}`,
a raw inline style rather than a Tailwind utility.

**Extended scope (not in original brief):** The same undefined `--accent-positive`
token appears in two additional primitives discovered during this audit:

- `sparkline.tsx:13` — `stroke = up ? 'var(--accent-positive)' : 'var(--accent-warm)'`
- `pct-delta-cell.tsx:8` — `color = up ? 'var(--accent-positive)' : 'var(--accent-warm)'`

All three primitives will show no color for the "up" direction until the token
is defined or the references are migrated to `--accent-green` / `var(--positive)`.

### 4. `card.tsx:9,49` — double-padding when `Card` + `CardContent` are composed

`Card` applies `p-4 sm:p-5` (line 9). `CardContent` applies `px-5 py-5` (line
49). When a consumer wraps content in `<Card><CardContent>…</CardContent></Card>`,
both padding rules stack, producing asymmetric or doubled spacing. Consumers
that want the Card chrome without double-padding must pass `className="p-0"` to
override, a non-obvious workaround.

---

## Gaps

Primitives the rules doc (Task 2) will need to bless, but which do not yet exist:

1. **Page-level content `Section` wrapper** — there is no canonical `<Section>`
   component for grouping content below `PageHeader`. Pages improvise with raw
   `<div>`, `<section>`, or Card wrappers. A blessed `Section` (heading + body
   region + optional actions) would standardize page structure.

2. **Stat-grid layout primitive** — `StatCard` exists but there is no blessed
   grid container for laying out a row of stat cards. Pages use ad-hoc
   `grid grid-cols-2 md:grid-cols-4 gap-4` inline. A `StatGrid` component
   (or at minimum a documented Tailwind snippet) would enforce consistent
   responsive breakpoints.

3. **Canonical loading-row pattern** — `SkeletonRow` exists in `skeleton.tsx`
   but its usage is ad-hoc (callers pick arbitrary `cols` counts; there is no
   `LoadingTable` or `TableSkeleton` that mirrors a table's real column count).
   A blessed loading-table wrapper would eliminate per-page guessing.
