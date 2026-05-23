# Wave 1 — sidebar nav + dashboard bento expansion

**Date:** 2026-05-23
**Status:** approved (brainstorming), implementing
**Scope:** one PR. Touches `frontend/src/components/Layout.tsx`, adds `frontend/src/components/Sidebar.tsx`, adds five new components under `frontend/src/components/dashboard/`, extends `frontend/src/pages/ReportsPage.tsx`, and refactors `frontend/src/pages/DashboardPage.tsx`.

**Predecessor**: [`2026-05-22-honey-ink-brand-palette-design.md`](./2026-05-22-honey-ink-brand-palette-design.md) — Honey & Ink palette + initial bento.

---

## Goals

1. Move primary navigation from a horizontal top bar into a left sidebar.
2. Expand the dashboard bento with three new analytical tiles (top growers, recurring this month, currency mix).
3. Bento-ify the four below-bento tables — three become 6×2 / 12×2 tiles, one (category report) drops as redundant with the Top categories chart.
4. Densify by shrinking the Activity-by-month line chart from 12×2 to 6×2 and using the freed slot.
5. Extend `/reports` with comprehensive merchant + account ranking sections so the bento's "View all" links have a destination.

## Non-goals

- No new API endpoints. (Daily aggregation for the anomalies tile is deferred to Wave 1.5.)
- No sidebar collapse-to-icon mode (deferred to Wave 1.5).
- No drag/resize/persisted bento layout.
- No changes to Transactions, Accounts, Review, Portfolio, Amazon, Recurring, Rules, Settings pages (besides the auto-shift right by 240px).

---

## Section A — Sidebar nav + top bar

### Layout grid

```css
.layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
}
@media (max-width: 768px) {
  .layout { grid-template-columns: 1fr; }
}
```

### Sidebar

- Fixed full-height column on the left, 240px wide on desktop, off-canvas drawer below 768px.
- Three vertical sections:
  - **Top**: brand mark (`CF`) + "Cashflow" / "Household ledger" eyebrow — moved from the existing `.brandLockup` in `Layout.tsx`.
  - **Middle**: flat vertical list of all 10 nav routes (`Dashboard`, `Accounts`, `Review`, `Transactions`, `Portfolio`, `Amazon`, `Recurring`, `Rules`, `Reports`, `Settings`). Each row ~40px tall, icon + label. Reuses the existing `navItems` array shape.
    - Active state: card-background tint + 3px amber left rail + foreground text color.
    - Hover: subtle muted-bg.
    - Focus-visible: amber ring offset.
  - **Bottom**: theme toggle (Sun/Moon) + `displayName` + optional God-mode badge + logout button, stacked.

### Top bar

- Stripped to a thin sticky strip. Loses `<nav>` and `.brandLockup` (both move to sidebar). Loses theme toggle + user menu (also sidebar).
- Desktop: empty by default — reserved for future page-specific actions (hidden but kept as a `<header>` landmark for a11y; ~auto height when empty, room for future content).
- Mobile (<768px): renders a hamburger toggle that opens the sidebar drawer + a `Cashflow` wordmark for branding (since sidebar is hidden until opened).

### Mobile drawer behavior

- Hidden via `transform: translateX(-100%)`; toggled to `translateX(0)`.
- Backdrop overlay (`position: fixed; inset: 0; background: rgba(0,0,0,0.4)`) appears when open, click-to-close.
- Body scroll lock while drawer is open.
- Escape key closes the drawer.
- Auto-close on route change (clicking a nav link should dismiss the drawer).

### Per-page impact

Every page auto-shifts right by 240px on desktop. No per-page edits needed in this PR. Pages that internally use full-width assumptions (Dashboard bento, Recharts containers) re-flow naturally because Recharts and CSS Grid both respond to container width.

---

## Section B — Three new bento tiles

All three are 6×2 and consume data already fetched (or fetched via one new endpoint call).

### B.1 — Top growers (6×2)

```
┌─────────────────────────────────────┐
│ Top growers                         │
│ Categories with biggest change vs   │
│ previous period                     │
│ ─────────────────────────────────── │
│ Groceries     $1,240   +$310 (+33%) │
│ Subscriptions   $182   +$95 (+109%) │
│ Restaurants     $480   -$210 (-30%) │
│ Transport      $312    +$84  (+37%) │
│ Coffee          $58    +$22  (+61%) │
└─────────────────────────────────────┘
```

- Top 5 categories by `Math.abs(currentNetSpend - previousNetSpend)`.
- Delta chip uses `metricKind="spend"` semantics — positive delta is red (spend up = bad), negative is green.
- "New this period" badge when category is present only in current period.
- Empty state: "Set both dates for period comparison" when `previousRange == null`.
- File: `frontend/src/components/dashboard/TopGrowersTile.tsx`.

**Data plumbing**: in `DashboardPage`, replace `setPreviousMetricsByCurrency(prev?.metricsByCurrency ?? [])` with also capturing `setPreviousCategoryReports(prev?.categoryReports ?? [])`. The response already includes `categoryReports`; today it's discarded.

### B.2 — Recurring this month (6×2)

```
┌─────────────────────────────────────┐
│ Recurring this month                │
│ Charges expected this calendar month│
│ ─────────────────────────────────── │
│ Netflix         $18.00     May 28   │
│ Spotify         $11.99     Jun 02   │
│ Google One       $1.99     Jun 03   │
│ Adobe CC        $63.49     Jun 12   │
│ Apple iCloud     $3.99     Jun 18   │
│ ─────────────────────────────────── │
│ Total: $99.46    All recurring →    │
└─────────────────────────────────────┘
```

- Fetched from `/api/recurring?currency=<x>` (existing route).
- Filter client-side where `item.nextExpected.slice(0,7) === currentYearMonth` (current calendar month).
- Sort by `nextExpected` ascending. Slice top 5.
- Row click → `/transactions?merchant=<name>`.
- Footer: total + "All recurring →" link to `/recurring`.
- Empty state: "No recurring charges expected this month."
- Loading state: own `recurringLoading` flag.
- File: `frontend/src/components/dashboard/RecurringThisMonthTile.tsx`.

**Data plumbing**: in `DashboardPage`, add a `useEffect` that fetches `/api/recurring?currency=<currency>` on currency change, wrapped in try/catch (failure → empty list, like AI insights pattern at the existing aiInsights effect). New state: `recurringItems: RecurringItem[]` and `recurringLoading: boolean`.

### B.3 — Currency mix (6×2)

```
┌─────────────────────────────────────┐
│ Currency mix                        │
│ Share of net spend across all       │
│ currencies in your data             │
│ ─────────────────────────────────── │
│ ████████████░░░░░░░░░░░░░  (bar)   │
│ ● CAD  $4,120  62%                  │
│ ● USD  $1,840  28%                  │
│ ● EUR    $660  10%                  │
└─────────────────────────────────────┘
```

- Horizontal stacked bar (~24px tall) showing each currency's share of total absolute net spend.
- Compact legend below: color dot + currency code + amount + percent.
- Uses `--chart-line-N` ordinal palette so bar segments and legend dots match.
- **Always renders** — sources `data.metricsByCurrency` directly, ignoring the dashboard's currency filter (so it's a stable global-exposure view).
- Empty state when `data.metricsByCurrency.length < 2`: "Currency mix shows when you have transactions in 2+ currencies."
- File: `frontend/src/components/dashboard/CurrencyMixTile.tsx`.

**Data plumbing**: none. Reuses existing `data.metricsByCurrency`.

---

## Section C — Bento'd tables

### C.1 — Top merchants (6×2)

- Top 6 from `merchantReportData`. Columns: merchant, txns, net spend.
- Row click → `/transactions?merchant=<name>&currency=<x>&dateFrom=<from>&dateTo=<to>`.
- Footer: "All merchants in Reports →" → `/reports#merchants`.
- Empty state: "No merchant activity in this view."

### C.2 — Top accounts (6×2)

- Top 6 from `accountReportData`. Columns: account (use `accountShortCode ?? accountName`), txns, net spend.
- Row click → `/transactions?account=<id>&currency=<x>&dateFrom=<from>&dateTo=<to>`.
- Footer: "All accounts in Reports →" → `/reports#accounts`.
- Empty state: "No account activity in this view."

### C.3 — Review queue (12×2)

- Top 6 from `reviewQueueData`. Columns: date, merchant, account, category, amount.
- Row click → `/review`.
- Footer: "Open Review Inbox →" → `/review`.
- Empty state: "Nothing flagged in this view."

### Dropped: Category report table

Redundant with the Top categories chart tile (bento Row 3). The chart already shows ranked categories with click-to-drill into `/transactions?category=<x>`.

### Shared component: `TableTile`

```tsx
type TableTileColumn<R> = {
  key: string
  label: string
  align?: 'left' | 'right'
  render: (row: R) => React.ReactNode
}

type TableTileProps<R> = {
  span: 6 | 12
  rows: R[]
  rowKey: (row: R) => string
  columns: TableTileColumn<R>[]
  onRowClick?: (row: R) => void
  label: string
  description?: string
  viewAllLabel: string
  viewAllHref: string
  emptyLabel: string
  loading?: boolean
}

export function TableTile<R>(props: TableTileProps<R>): JSX.Element
```

Lives at `frontend/src/components/dashboard/TableTile.tsx`. Wraps `BentoTile`. Renders a compact `<table>` (not the heavy `<Table>` from `components/ui/table` — simpler, fits in tile constraints). Clickable rows have `cursor: pointer` and `tabIndex={0}` + Enter/Space key handler for a11y.

### ReportsPage extension

Add two sections to `frontend/src/pages/ReportsPage.tsx`:

```tsx
<section id="merchants" className="card">
  <h2>Merchants</h2>
  <p className="muted">All merchants in this view, ranked by net spend.</p>
  <table>... full columns ...</table>
</section>

<section id="accounts" className="card">
  <h2>Accounts</h2>
  <p className="muted">All accounts in this view, ranked by net spend.</p>
  <table>... full columns ...</table>
</section>
```

Implementation step decides whether ReportsPage reuses its existing data fetch or calls `/api/summary/dashboard` for the merchant/account arrays. Whichever is simpler.

Anchor jump from bento `view all` links: rely on default browser behavior (`<Link to="/reports#merchants">` → router navigates, browser scrolls to `#merchants` after mount). May need a tiny `useEffect(() => { if (window.location.hash) { document.getElementById(...)?.scrollIntoView() } }, [])` if React Router doesn't preserve hash scrolling.

---

## Section D — Final bento layout

| Row | Tiles | Notes |
|---|---|---|
| 0 | Budget pills 12×1 | Conditional, unchanged from Wave 0 |
| 1 | Hero 8×2 \| KPI stack 4×2 | Unchanged |
| 2 | Business vs personal 6×2 \| Monthly flow 6×2 | Unchanged |
| 3 | Top categories 8×2 \| AI insights 4×2 | Unchanged |
| 4 | Activity by month 6×2 \| Top growers 6×2 | Densified — was 12×2 |
| 5 | Recurring this month 6×2 \| Currency mix 6×2 | New tiles |
| 6 | Top merchants 6×2 \| Top accounts 6×2 | Table-tiles |
| 7 | Review queue 12×2 | Wide finale, table-tile |

8 rows (7 without budgets). Below-bento `dashboardTableCard` sections are deleted.

**Activity-by-month at 6×2**: set `height={220}` (down from 260) to match other 6×2 chart tiles. Recharts handles the resize; existing `isNarrowViewport` adaptations cover label/tick density at narrower widths.

**Visual rhythm**: 8+4, 6+6, 8+4, 6+6, 6+6, 6+6, 12. Settled rhythm with two 8+4 accents and a 12-wide closer.

---

## Section E — Migration

### Order within the PR

1. **Sidebar component + Layout grid restructure**. New `Sidebar.tsx`. `Layout.tsx` becomes grid wrapper; top bar stripped to mobile hamburger. App.css gains `.sidebar`, `.sidebar__*` classes; updates `.layout`, `.header`, `.main`.
2. **ReportsPage extension**. Merchant + account sections with anchors.
3. **Bento data plumbing in DashboardPage**. `previousCategoryReports` state. Recurring fetch effect.
4. **Three new tile components**. `TopGrowersTile`, `RecurringThisMonthTile`, `CurrencyMixTile`.
5. **TableTile + three table-tile compositions** inline in DashboardPage (or extracted as `TopMerchantsTile.tsx` / `TopAccountsTile.tsx` / `ReviewQueueTile.tsx` if reuse emerges).
6. **DashboardPage bento reflow**. Insert new tiles per Section D. Shrink Activity height. Delete four `<section className="card dashboardTableCard">` blocks.

### Compatibility

- Sidebar nav uses the same 10 routes; nothing route-related changes.
- All other pages auto-shift right; no per-page edits.
- `.dashboardTableCard` CSS stays one cycle (extended ReportsPage may reuse it); sweep later.
- TypeScript: `RecurringItem` and the recurring response type need to be added to `frontend/src/types/api.ts` (or wherever `BudgetProgress` lives).

### Risks

- **Mobile drawer polish** — backdrop, scroll-lock, escape-to-close, route-change auto-close. Standard but non-trivial.
- **ReportsPage existing fetch pattern** — verify what endpoint it hits; the implementation step may need to add a parallel call to `/api/summary/dashboard` for merchantSummaries/accountSummaries.
- **Hash-anchor scrolling** under React Router — may need a tiny effect to scroll on mount when hash present.
- **Sidebar active state** must reuse `NavLink isActive` logic including `end` prop on `/`.
- **No new endpoint** — anomalies tile is intentionally absent. Confirm before merge that the bento doesn't have an awkward gap from the missing tile (Section D explicitly designs around its absence).

### Verification

- `yarn workspace frontend run lint`, `tsc -b`, vitest, `vite build` all clean.
- Theme toggle flips sidebar surfaces correctly.
- AA contrast on sidebar active state (amber tint on `--card`).
- Navigate via sidebar to every route, no layout breakage.
- Drill rows on table-tiles navigate with correct filters.
- "View all" links scroll to `#merchants` / `#accounts` on Reports.
- Resize 1440 / 1024 / 768 / 375 px — sidebar drawer behavior at 768, bento single-column at 639.

### Deferred to Wave 1.5

- **Anomalies tile + `/api/summary/daily` endpoint**. Backend first; tile drops into bento (likely new row below current Row 5).
- **Sidebar collapse-to-icon-only**. Manual toggle + auto-collapse at 768-1023px.
- **Top-growers row drill** into `/transactions?category=<x>&dateFrom=<prev.from>&dateTo=<current.to>`.
