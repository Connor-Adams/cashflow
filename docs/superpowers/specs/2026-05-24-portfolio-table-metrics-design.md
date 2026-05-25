# Slice A — More Metrics on Portfolio Tables

**Status:** Design spec. Third slice from the [Portfolio Enrichment Umbrella](./2026-05-24-portfolio-enrichment-vision.md).
**Date:** 2026-05-24
**Scope:** Single PR. Extends existing `/api/portfolio` and `/api/portfolio/by-security` endpoint responses with per-row return/yield/weight metrics. Adds chip-style cells to the Holdings and By-security tables. Adds today-change to the unified-CAD top stat card.

---

## 1. Goal

Holdings and By-security tables stop being a balance sheet; become a dashboard. Today's change, 30-day total return, weight of portfolio (unified CAD), yield on cost, and cumulative total return (by-security) appear inline per row. Top stat card shows today's portfolio-level change.

## 2. Decisions locked from the brainstorm

| Question | Decision |
|---|---|
| Weight % basis | Unified CAD. `weightPct = cadMarketValue / unifiedTotal.cadMarketValue × 100`. Reuses slice F's BoC FX wiring. |
| target_weight / Allocation drift | **Deferred** to a separate later slice. Out of scope here. |
| Endpoint strategy | Extend existing `/api/portfolio` + `/api/portfolio/by-security` responses with new per-row fields. No new endpoint. |
| Stat / chip layout in tables | Lightweight `<PctDeltaCell>` (one-line `↑/↓ X.XX%`, color-coded). Not full `<MetricStat>` cards — those are reserved for the top stats row. |
| Top stat card | Existing `Total (CAD)` becomes a `<MetricStat>` with `deltaPct={unifiedTotal.todayChangePct}`. |

## 3. Today's state recap

- Slice F shipped per-detail-page formulas for `todayChangePct`, `thirtyDayReturnPct`, `yieldOnCostPct` in the existing `/api/portfolio/security/:id` `combined` block. This slice generalizes those to all rows in Holdings + By-security.
- Slice E shipped the `<SecurityLogo>` + `<Sparkline>` row decorations; new metric columns insert between Unrealized and the existing 30d sparkline column.
- `unifiedTotal` block on `/api/portfolio` already exists with `marketValue` (CAD) + `ratesUsed`. Per-row CAD conversion uses the same BoC FX rates via `ensureFxRate`.

## 4. Backend

### 4.1 `/api/portfolio` extensions

**Per-row, on each item of `holdings[]`:**

| Field | Type | Formula | Null when |
|---|---|---|---|
| `todayChangePct` | `number \| null` | `(currentQuote − prevClose) / prevClose × 100` | no `SecurityPrice` row OR no `security_daily_prices` row from yesterday |
| `thirtyDayReturnPct` | `number \| null` | `((today + divs_per_unit_30d) − price_30d_ago) / price_30d_ago × 100` | no daily-price row ≤30d old |
| `weightPct` | `number \| null` | `cadMarketValue(holding) / unifiedTotal.cadMarketValue × 100` | `unifiedTotal == null` OR FX rate unavailable for holding's currency |
| `yieldOnCostPct` | `number \| null` | `sum_div_per_unit_365d × qty / costBasis × 100` | `costBasis == null \|\| costBasis == 0` |

**Top-level `unifiedTotal` block — new fields:**

| Field | Type | Formula | Null when |
|---|---|---|---|
| `todayChangePct` | `number \| null` | `(sumTodayCadMV − sumPrevCadMV) / sumPrevCadMV × 100` | sumPrev <= 0 OR no securities have prev-day daily prices |
| `todayChangeCad` | `number \| null` | `sumTodayCadMV − sumPrevCadMV` | same |

Where `sumTodayCadMV` = sum of all visible holdings' CAD market values, `sumPrevCadMV` = sum of (qty × yesterday's adj_close × FX) for the same set. Only securities with prev-day daily prices contribute to either sum (any other holding is uncountable for the delta).

### 4.2 `/api/portfolio/by-security` extensions

**Per-row, on each item of `rows[]`:**

| Field | Type | Formula | Null when |
|---|---|---|---|
| `todayChangePct` | `number \| null` | same as Holdings | same |
| `thirtyDayReturnPct` | `number \| null` | same | same |
| `weightPct` | `number \| null` | aggregated CAD MV / unifiedTotal CAD × 100 | unifiedTotal null OR FX unavailable |
| `totalReturnPct` | `number \| null` | `(currentMV + realizedToDate + lifetimeIncome − costBasis) / costBasis × 100` | `costBasis == null \|\| 0` |

**Top-level on `/by-security` response:** ADD `unifiedTotal` block mirroring `/api/portfolio`'s shape (`cadMarketValue`, `todayChangePct`, `todayChangeCad`, `ratesUsed`). Redundant with the same field on `/api/portfolio` but lets the by-security tab compute its own weights without joining client-side.

**Note on `realizedToDate` + `lifetimeIncome`:** the existing `loadVisibleLatestHoldings` does not surface these per-security. We need one extra grouped query per request:

```ts
// Per-security aggregates from InvestmentActivity:
//   realizedToDate = sum of realizedGain across SELL events (existing ACB engine)
//   dividendsTotal = sum of dividend amounts
//   interestTotal  = sum of interest amounts
```

Implementation: extract into a helper `loadIncomeAndRealizedBySecurity(req, securityIds)` in `backend/src/portfolio/metrics.ts`.

### 4.3 New module — `backend/src/portfolio/metrics.ts`

Single file containing all per-row metric computation and the batch context loader. Used by both endpoints.

```ts
export type MetricsContext = {
  latestDaily: Map<number, { close: number; adjClose: number; date: string }>   // most recent
  prevDaily: Map<number, { close: number; adjClose: number; date: string }>     // 2nd-most-recent (for prevClose)
  daily30dAgo: Map<number, { adjClose: number }>                                // closest row >=30d old
  latestQuotes: Map<number, { price: number; currency: string }>                // SecurityPrice latest
  divPerUnit30d: Map<number, number>
  divPerUnit365d: Map<number, number>
  fxRates: Map<string, number>                                                  // currency → CAD rate
  realizedBySec: Map<number, number>                                            // realized total per security
  dividendsBySec: Map<number, number>                                           // lifetime dividends per security
  interestBySec: Map<number, number>                                            // lifetime interest per security
}

export async function loadMetricsContext(
  securityIds: number[],
  currencies: string[],
  accountIds: number[],
): Promise<MetricsContext>

export type RowMetrics = {
  todayChangePct: number | null
  thirtyDayReturnPct: number | null
  yieldOnCostPct: number | null
}

export function computeRowMetrics(args: {
  ctx: MetricsContext
  securityId: number
  qty: number
  costBasis: number | null
}): RowMetrics

export function computeWeightPct(args: {
  ctx: MetricsContext
  cadMarketValue: number
  unifiedTotalCad: number | null
}): number | null

export function computeTotalReturnPct(args: {
  ctx: MetricsContext
  securityId: number
  currentMV: number
  costBasis: number | null
}): number | null

export function computeUnifiedTodayDelta(args: {
  ctx: MetricsContext
  holdings: Array<{ securityId: number; quantity: number; currency: string }>
}): { todayChangePct: number | null; todayChangeCad: number | null }
```

Each function is pure (takes context, returns numbers/null). Easy to unit-test.

### 4.4 Backend tests

- `backend/test/portfolio/metrics.test.ts` — unit tests for each pure function with stub contexts:
  - `computeRowMetrics` — all fields populated; missing prevDaily → todayChangePct null; missing daily30dAgo → 30d null; missing costBasis → yield null
  - `computeWeightPct` — null when unifiedTotal null OR cadMarketValue 0
  - `computeTotalReturnPct` — null when costBasis null/0; correct when populated
  - `computeUnifiedTodayDelta` — null when no securities have prev-day; correct sum
- Extend `backend/test/integration/portfolioBySecurity.test.ts` — seed daily prices + dividends + sells; assert new fields populate; assert nulls for empty cases
- New `backend/test/integration/portfolioMetrics.test.ts` — exercise `/api/portfolio` endpoint, assert new `holdings[].todayChangePct` etc. + `unifiedTotal.todayChangePct`

## 5. Frontend

### 5.1 Shared type extensions (`shared/api-types.ts`)

```ts
// PortfolioSummary.holdings[] — add:
todayChangePct: number | null
thirtyDayReturnPct: number | null
weightPct: number | null
yieldOnCostPct: number | null

// PortfolioSummary.unifiedTotal — add:
todayChangePct: number | null
todayChangeCad: number | null

// PortfolioBySecurity.rows[] — add:
todayChangePct: number | null
thirtyDayReturnPct: number | null
weightPct: number | null
totalReturnPct: number | null

// PortfolioBySecurity — add new top-level:
unifiedTotal: {
  cadMarketValue: number
  todayChangePct: number | null
  todayChangeCad: number | null
  ratesUsed: Array<{ from: string; to: 'CAD'; rate: number; ratedDate: string }>
} | null
```

### 5.2 New component — `<PctDeltaCell>`

`frontend/src/components/ui/pct-delta-cell.tsx`:

```tsx
export function PctDeltaCell({ value }: { value: number | null }) {
  if (value == null) return <>—</>
  const up = value >= 0
  const color = up ? 'var(--accent-positive)' : 'var(--accent-warm)'
  const arrow = up ? '↑' : '↓'
  return (
    <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>
      {arrow} {Math.abs(value).toFixed(2)}%
    </span>
  )
}
```

`frontend/src/components/ui/pct-delta-cell.test.tsx`:
- renders em-dash for null
- positive → up arrow + green color
- negative → down arrow + warm color
- 0 → up arrow (≥0 branch)

### 5.3 Holdings table — new columns

Insert between **Unrealized** and the slice-E **30d** sparkline column:

| Header | Cell render |
|---|---|
| Today | `<PctDeltaCell value={holding.todayChangePct} />` |
| 30d Δ | `<PctDeltaCell value={holding.thirtyDayReturnPct} />` |
| Weight | `holding.weightPct != null ? holding.weightPct.toFixed(1) + '%' : '—'` |
| Yield | `holding.yieldOnCostPct != null ? holding.yieldOnCostPct.toFixed(2) + '%' : '—'` |

`<EmptyTableRow colSpan>` bumps from 10 to **14**.

### 5.4 By-security table — new columns

Insert between **Unrealized** and the slice-E **30d** sparkline column:

| Header | Cell render |
|---|---|
| Today | `<PctDeltaCell value={row.todayChangePct} />` |
| 30d Δ | `<PctDeltaCell value={row.thirtyDayReturnPct} />` |
| Weight | `row.weightPct != null ? row.weightPct.toFixed(1) + '%' : '—'` |
| Total Return | `<PctDeltaCell value={row.totalReturnPct} />` |

`<EmptyTableRow colSpan>` bumps from 10 to **14**.

### 5.5 Top stats row — Total (CAD) becomes MetricStat

Replace the existing `<StatCard label="Total (CAD)" value={...} hint={...}>` with `<MetricStat label="Total (CAD)" value={...} deltaPct={unifiedTotal.todayChangePct} hint={...}>`. Other top stat cards unchanged.

### 5.6 Frontend tests

- `frontend/src/components/ui/pct-delta-cell.test.tsx` — new
- Extend `frontend/src/pages/PortfolioPage.test.tsx`:
  - Holdings row renders all four new columns (assert text or `<PctDeltaCell>` semantics)
  - Top stat card renders deltaPct when present
  - Null fields render em-dash

## 6. Out of scope

- Allocation drift / `target_weight` (deferred)
- Beta, alpha, Sharpe ratio
- Weighted-average yield aggregate at top stats row
- Per-row annualized return (only cumulative total return per spec)
- Income / Realized table per-row metrics (umbrella keeps those tabs lean)

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Users with no daily-price history → all per-row metrics show "—" | Acceptable; matches slice E sparkline empty-state. Slice F backfill seeds history as user explores. |
| 2 | Per-row FX lookup → N DB calls if naive | `loadMetricsContext` batches FX rate fetches once per distinct currency per request. |
| 3 | Tables become wide on narrow screens (14 columns) | Existing horizontal-scroll behavior on `transactionsTable` wrapper covers it. |
| 4 | Total Return % includes dividends/interest cross-currency mixed naively | Same as existing `combinedRealized` TODO already in `/security/:id` — flagged in code; out of scope to fix here. |
| 5 | Adding `unifiedTotal` to `/by-security` is technically duplication of the same block on `/api/portfolio` | Cost is small (~100 bytes JSON). Avoids client-side joining and keeps tabs self-contained. |

## 8. Acceptance criteria

1. `/api/portfolio` `holdings[]` rows include `todayChangePct`, `thirtyDayReturnPct`, `weightPct`, `yieldOnCostPct`. Each is `null` when its formula's preconditions aren't met.
2. `/api/portfolio` `unifiedTotal` includes `todayChangePct` + `todayChangeCad` (both `null` when no securities have prev-day prices).
3. `/api/portfolio/by-security` `rows[]` include `todayChangePct`, `thirtyDayReturnPct`, `weightPct`, `totalReturnPct`. Each `null` per its preconditions.
4. `/api/portfolio/by-security` response includes a top-level `unifiedTotal` block.
5. Holdings table renders four new columns (Today, 30d Δ, Weight, Yield) between Unrealized and the existing 30d sparkline. Each cell renders `—` when its field is `null`.
6. By-security table renders four new columns (Today, 30d Δ, Weight, Total Return) in the same slot. Same null behavior.
7. Top `Total (CAD)` stat card shows a delta arrow when `unifiedTotal.todayChangePct != null`.
8. No new external API calls. `loadMetricsContext` only queries local DB.
9. Existing portfolio test suites still pass. New unit + integration tests pass.
10. Frontend build, lint, typecheck clean.

## 9. Next step

User reviews. Approve → invoke `superpowers:writing-plans` for file-by-file plan.
