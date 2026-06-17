# Cashflow UI Rules

North-star: the Dashboard's *look*. Implementation target: the `components/ui/` primitives.
"Match the Dashboard" means match its polish — NOT copy its raw-CSS/inline-style internals.

## Spacing
- Page content vertical rhythm: `space-y-4` between major blocks (matches Dashboard `gap-4`).
- Grid gaps: `gap-3` (dense forms/stat grids), `gap-4` (tile/section grids).
- Section top spacing after header: header owns `mb-4` (see `PageHeader`). No ad-hoc `mt-*` on the first block.
- NO inline `margin`/`padding` via `style={{}}`. Use utilities.

## Page anatomy (one blessed structure)
1. `<div className="page">` wrapper (keep; it is layout-neutral).
2. `<PageHeader title description actions />` — the only page title source.
3. Optional toolbar/filter row (Card-wrapped FilterBar like Dashboard, or a `flex flex-wrap gap-2` action row).
4. Content blocks separated by `space-y-4`.

## Typography
- Page title: `PageHeader` h1 (do not hand-roll `<h1>`).
- Section label: `text-sm font-medium text-muted-foreground`.
- Body: default; muted/help text: `text-sm text-muted-foreground` (NOT the `.muted` class in new code).
- Numeric stat value: use `StatCard` (`value` prop); don't hand-roll `.statValue`.

## Density (tables)
- Use the `Table`/`TableHeader`/`TableRow`/`TableHead`/`TableCell` primitives. They already set row borders, `px-3`, header casing, hover. Do NOT add a `.table` class or a `.tableWrap` wrapper — `Table` self-wraps in an overflow container.
- For dashboard-style compact summary tables, use `TableTile`.

## States (exactly one way each)
- Empty (in a table): `<EmptyTableRow colSpan title description />`.
- Empty (standalone block): `<EmptyState title description actions />`.
- Loading (table rows): existing `SkeletonRow`.
- Error banner: `<Alert variant="error">message</Alert>` (replaces the `.error` class).

## Color
- Tokens only via Tailwind utilities: `text-foreground`, `text-muted-foreground`, `bg-card`, `bg-muted`, `border-border`, `text-danger`, etc.
- No hex. No `var(--…)` in inline styles for new code (primitives may, until hardened).

## Stat grid (blessed layout)
- A responsive stat row: `<div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">` containing `<StatCard>`s. (Replaces `.accountsStats` + `.statCard`.)

## Rule gaps found during pilot

None — all pilot classes mapped to covered rules.
