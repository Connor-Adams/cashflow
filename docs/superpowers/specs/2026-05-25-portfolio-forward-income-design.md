# Slice C — Forward Income Tab

**Status:** Design spec. Fifth slice from the [Portfolio Enrichment Umbrella](./2026-05-24-portfolio-enrichment-vision.md).
**Date:** 2026-05-25
**Scope:** Single PR. New materialized `portfolio_forward_projections` table, nightly scheduler + Sequelize-hook-driven invalidation, new `GET /api/portfolio/forward-income` endpoint backing a new **Forward income** tab between Income and Realized. Projects per-holding annual dividend + interest income, forward yield + yield-on-cost, 90-day ex-div calendar, and taxStatus × assetType breakdowns.

---

## 1. Goal

Answer "how much income should I expect, and when?" Project forward annual dividend + interest income per holding using inferred cadence from the last 12 months of paid events, surface a 90-day upcoming-events calendar, and flag unreliable projections so users can plan cash flow with appropriate confidence.

## 2. Decisions locked from the brainstorm

| Question | Decision |
|---|---|
| Income types in scope | Dividends (from `security_dividends`) **and** interest (from `investment_activities` where `activityType='interest'`). |
| Quantity basis for projection | As-of-today qty from latest `holdings_snapshots` row per security. No weighted-average, no trailing/forward split. |
| Cadence inference algorithm | Sum amounts paid in last 12 months → `annualPerShare`. Implicit cadence from event count + spacing. |
| Forward yield denominator | Show **both**: `forwardYield = projectedAnnualIncome / currentMV` and `forwardYieldOnCost = projectedAnnualIncome / costBasis`. |
| FX conversion for CAD totals | Today's spot rate from `fx_rates` (same source as `unifiedTotal` in [PortfolioSummary](shared/api-types.ts)). |
| Unreliability flag | `cvPct > 25%` over last 4 payments **OR** fewer than 4 payments in history. Surfaced as `unreliable: boolean` per row; reasons listed in `caveats.holdingsWithoutHistory`. |
| Next ex-div date estimation | `lastExDiv + medianSpacing(last 4 inter-payment gaps)`. Median = robust to single outliers. |
| Ex-div calendar lookahead | 90 days forward. No user toggle in v1. |
| Tab placement | After Income, before Realized in [PortfolioPage.tsx](frontend/src/pages/PortfolioPage.tsx). |
| Bucket breakdowns | Two: byTaxStatus (TFSA/RRSP/FHSA/RRIF/Non-reg/N/A) × currency, and byAssetType (equity/etf/bond/...) × currency. Side-by-side panels. |
| Storage strategy | Materialized `portfolio_forward_projections` table. Nightly cron rebuild + Sequelize-hook stale-marking + lazy-on-read recompute. |

## 3. Today's state (recap)

- `SecurityDividend` table (from Slice F) stores per-security ex-dividend events with amount, currency, dates.
- `investment_activities` table holds `activityType='interest'` rows already aggregated alongside dividends in the existing Income tab ([portfolio.ts:498](backend/src/routes/portfolio.ts:498)).
- `holdings_snapshots` provides latest per-security qty + costBasis per household via existing `latestSnapshotsForHousehold` pattern.
- `fx_rates` provides today's spot rates; reused by `unifiedTotal` and [metrics.ts](backend/src/portfolio/metrics.ts).
- `node-cron` scheduler infra exists ([alphaVantage/scheduler.ts](backend/src/integrations/alphaVantage/scheduler.ts)) — pattern reused for forward income rebuild cron.
- Slice D's `bucketTaxStatus` + assetType conventions reused for breakdown panels.
- No existing forward projection table, no cadence inference helper, no Sequelize hooks for invalidation cascades.

## 4. Backend

### 4.1 New table — `portfolio_forward_projections`

Migration `backend/src/migrations/20260525000001-portfolio-forward-projections.js`:

```sql
CREATE TABLE portfolio_forward_projections (
  id                          BIGSERIAL PRIMARY KEY,
  household_id                BIGINT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  security_id                 BIGINT NOT NULL REFERENCES securities(id) ON DELETE CASCADE,

  qty_basis                   DECIMAL(20,8) NOT NULL,
  annual_dividend_per_share   DECIMAL(20,8) NOT NULL DEFAULT 0,
  annual_interest_per_share   DECIMAL(20,8) NOT NULL DEFAULT 0,
  projected_annual_income_native DECIMAL(20,2) NOT NULL DEFAULT 0,
  currency                    VARCHAR(8) NOT NULL,

  cadence_label               VARCHAR(16) NOT NULL,  -- 'monthly'|'quarterly'|'semiannual'|'annual'|'irregular'|'none'
  median_spacing_days         INTEGER,
  cv_pct                      DECIMAL(8,4),          -- null when <4 events
  unreliable                  BOOLEAN NOT NULL DEFAULT false,
  next_ex_div_dates           JSONB NOT NULL DEFAULT '[]'::jsonb,

  computed_at                 TIMESTAMP NOT NULL,
  stale_at                    TIMESTAMP,             -- non-null = needs rebuild
  created_at                  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_household_security UNIQUE (household_id, security_id)
);

CREATE INDEX idx_pfp_household_stale ON portfolio_forward_projections (household_id, stale_at);
```

`next_ex_div_dates` JSONB shape:

```json
[
  { "date": "2026-06-15", "estimatedPerShare": 0.24, "kind": "dividend" },
  { "date": "2026-07-15", "estimatedPerShare": 0.24, "kind": "dividend" }
]
```

Rationale:
- **Per-household per-security row** (UNIQUE constraint) — keeps invalidation surgical, supports per-security drill if needed.
- **Native-currency income stored, CAD computed at read** — FX drifts continuously; storing native + reading FX live keeps CAD totals fresh without per-FX-tick recompute.
- **Yield % not stored** — `forwardYield = annualIncome / currentMV` is a cheap divide using a fresh quote.
- **`unreliable` denormalized** — supports indexed filter queries; cv_pct can still be inspected directly.
- **JSON calendar inline** — 1-3 entries per 90d window per security; a child table adds joins for trivial payoff.
- **`stale_at` index** — supports fast "any stale rows for this household?" check on every endpoint read.

### 4.2 Pure compute helpers — `backend/src/portfolio/forwardIncome.ts`

```ts
export type CadenceLabel = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'irregular' | 'none';

export interface PaymentEvent {
  date: Date;                  // ex-dividend date or interest accrual date
  perShareAmount: number;
}

export interface CadenceResult {
  annualPerShare: number;      // sum of perShareAmount over last 12mo
  medianSpacingDays: number | null;  // null if <2 events
  cadenceLabel: CadenceLabel;
  cvPct: number | null;        // coefficient of variation over last 4; null if <4 events
  eventCount12mo: number;
}

export function inferCadence(events: PaymentEvent[], asOf: Date): CadenceResult;
//   - Filter events to last 365 days from asOf (exclusive of events after asOf)
//   - annualPerShare = sum(perShareAmount)
//   - inter-payment spacings = consecutive diffs in days (events sorted ascending by date); medianSpacingDays = median
//   - cadenceLabel from eventCount12mo:
//       10-15 → 'monthly' (allow ±2 for shifted distributions / mid-month specials)
//       3-5   → 'quarterly'
//       2     → 'semiannual'
//       1     → 'annual'
//       0     → 'none'
//       else (6-9 or 16+) → 'irregular'
//   - cvPct: take last 4 events sorted by date desc; cvPct = stddev / mean of their perShareAmount; null if fewer than 4 events

export function projectNextEvents(args: {
  lastEventDate: Date;
  medianSpacingDays: number;
  lastPerShareAmount: number;
  horizonDays: number;         // 90 for v1
  asOf: Date;
}): Array<{ date: Date; estimatedPerShare: number }>;
//   - Start at lastEventDate + medianSpacingDays; advance by medianSpacingDays until past asOf+horizonDays
//   - estimatedPerShare = lastPerShareAmount (flat assumption)

export interface ForwardProjectionInput {
  securityId: number;
  qtyToday: number;
  currency: string;
  dividendEvents: PaymentEvent[];   // last 13 months of SecurityDividend rows
  interestEvents: PaymentEvent[];   // last 13 months of investment_activities rows where activityType='interest'
  asOf: Date;
}

export interface ForwardProjectionOutput {
  qtyBasis: number;
  annualDividendPerShare: number;
  annualInterestPerShare: number;
  projectedAnnualIncomeNative: number;
  currency: string;
  cadenceLabel: CadenceLabel;       // chosen from whichever has the higher event count (dividend vs interest); 'none' if both zero
  medianSpacingDays: number | null;
  cvPct: number | null;             // from the dominant series
  unreliable: boolean;              // cv > 0.25 OR (eventCount12mo < 4 AND eventCount12mo > 0)
  nextExDivDates: Array<{ date: string; estimatedPerShare: number; kind: 'dividend' | 'interest' }>;
}

export function computeForwardProjection(input: ForwardProjectionInput): ForwardProjectionOutput;
```

All helpers are pure. No DB access. Mirrors [metrics.ts](backend/src/portfolio/metrics.ts) pattern.

### 4.3 Builder — `backend/src/portfolio/forwardIncomeBuilder.ts`

```ts
export async function rebuildForwardProjectionsForHousehold(householdId: number): Promise<{
  rebuilt: number;
  deleted: number;
}>;
//   1. Load latest holdings_snapshots per security for household (qty > 0)
//   2. Load all SecurityDividend rows for those securityIds, last 13 months
//   3. Load all InvestmentActivity rows for those securityIds, type='interest', last 13 months, household-scoped
//   4. For each security: call computeForwardProjection, upsert into portfolio_forward_projections
//   5. Delete portfolio_forward_projections rows for securities not in current holdings
//   6. Clear stale_at on all touched rows
//   Returns counts.

export async function rebuildForwardProjectionsForAllHouseholds(): Promise<{
  households: number;
  rebuilt: number;
  deleted: number;
}>;
//   Iterates households, calls per-household rebuild. Used by nightly cron.

export async function markStaleForHousehold(householdId: number, securityId?: number): Promise<void>;
//   Sets stale_at = NOW() on matching rows. If securityId omitted, marks all household rows stale.

export async function markStaleForAllHoldersOfSecurity(securityId: number): Promise<void>;
//   Sets stale_at = NOW() on all rows matching securityId across all households.
//   Used when SecurityDividend changes (affects every holder of that ticker).
```

### 4.4 Stale invalidation via Sequelize hooks

Hooks registered in model definitions (not per-call sites — guarantees coverage):

| Model | Hook | Action |
|---|---|---|
| `InvestmentActivity` | `afterCreate`, `afterUpdate`, `afterDestroy` | If `activityType='interest'` OR side-effect on cost basis (i.e. buy/sell): `markStaleForHousehold(householdIdFromAccount, securityId)`. |
| `SecurityDividend` | `afterCreate`, `afterUpdate`, `afterDestroy` (and per `upsert` outcome) | `markStaleForAllHoldersOfSecurity(securityId)`. |
| `HoldingSnapshot` | `afterCreate` | `markStaleForHousehold(householdId, securityId)`. |

Hooks resolve `householdId` from the activity's `accountId → Account.householdId`. Sequelize `instance.changed()` checks skip no-op updates.

**No bulk-import thrash:** activities created in bulk fire one hook call each. Stale-marking is cheap (single UPDATE). Recompute happens once on next read.

### 4.5 Nightly cron — `backend/src/portfolio/forwardIncomeScheduler.ts`

Same shape as [alphaVantage/scheduler.ts](backend/src/integrations/alphaVantage/scheduler.ts):

```ts
export interface ForwardIncomeTickResult {
  status: 'skipped_disabled' | 'ran' | 'error';
  householdsProcessed?: number;
  rebuilt?: number;
  deleted?: number;
  error?: string;
}

export async function runForwardIncomeTick(): Promise<ForwardIncomeTickResult>;
export function startForwardIncomeScheduler(): ScheduledTask | null;
export function stopForwardIncomeScheduler(): void;
```

- Cron expression: `0 2 * * *` (02:00 local). Configurable via `env.forwardIncomeCron`.
- Feature flag: `env.forwardIncomeEnabled` (default true).
- Re-entrancy guard pattern from existing scheduler.
- Logs `forward_income_tick` with counts via `logger.info`.

Wired in `backend/src/server.ts` alongside `startQuoteScheduler()`.

### 4.6 New endpoint — `GET /api/portfolio/forward-income`

Route in [backend/src/routes/portfolio.ts](backend/src/routes/portfolio.ts), placed adjacent to other `/portfolio/*` routes.

Authenticated, household-scoped via `currentAuth(req).household` + `visibleAccountWhere(req)` + `accountType='investment'`.

Flow:
1. Query `portfolio_forward_projections` for household.
2. If any row has `stale_at IS NOT NULL`, OR no rows exist for a held security: `await rebuildForwardProjectionsForHousehold(householdId)`. Synchronous — adds ~50ms only after stale events.
3. Reload rows.
4. Load latest quotes + FX rates (reuse [metrics.ts](backend/src/portfolio/metrics.ts) helpers).
5. Compute yields + CAD conversions + breakdowns inline.
6. Build `upcoming90d` by flattening + sorting `next_ex_div_dates` from all rows.

Response (defined in [shared/api-types.ts](shared/api-types.ts)):

```ts
export interface PortfolioForwardIncome {
  totals: {
    projectedAnnualIncomeCad: number;
    projectedAnnualIncomeByCurrency: Array<{ currency: string; amount: number }>;
    forwardYieldPct: number;
    forwardYieldOnCostPct: number;
    computedAt: string;          // oldest row.computed_at across the set
    fxRateUsedAt: string;
  };
  rows: Array<{
    securityId: number;
    symbol: string;
    name: string;
    assetType: string | null;
    currency: string;
    qty: number;
    currentMvNative: number;
    costBasisNative: number;
    annualDividendPerShare: number;
    annualInterestPerShare: number;
    projectedAnnualIncomeNative: number;
    projectedAnnualIncomeCad: number;
    forwardYieldPct: number;
    forwardYieldOnCostPct: number;
    cadenceLabel: 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'irregular' | 'none';
    cvPct: number | null;
    unreliable: boolean;
    nextExDivDates: Array<{
      date: string;
      estimatedPerShare: number;
      estimatedTotal: number;     // qty * perShare
      kind: 'dividend' | 'interest';
    }>;
  }>;
  byTaxStatus: Array<{
    taxStatus: 'registered_rrsp' | 'registered_tfsa' | 'registered_fhsa' | 'registered_rrif' | 'non_registered' | 'n_a';
    byCurrency: Array<{ currency: string; amount: number }>;
    totalCad: number;
  }>;
  byAssetType: Array<{
    assetType: string;
    byCurrency: Array<{ currency: string; amount: number }>;
    totalCad: number;
  }>;
  upcoming90d: Array<{
    date: string;
    securityId: number;
    symbol: string;
    estimatedTotalNative: number;
    estimatedTotalCad: number;
    currency: string;
    kind: 'dividend' | 'interest';
  }>;
  caveats: {
    unreliableSecurityIds: number[];
    holdingsWithoutHistory: Array<{
      securityId: number;
      symbol: string;
      reason: 'no_dividend_history' | 'insufficient_history';
    }>;
  };
}
```

Empty-state behavior: household with no investment holdings returns all-zero structure (no error).

## 5. Frontend

### 5.1 Tab integration

In [PortfolioPage.tsx](frontend/src/pages/PortfolioPage.tsx) tab strip, insert "Forward income" between "Income" and "Realized". Lazy-fetched on tab activation (same pattern as Income/Realized).

### 5.2 Component tree — `frontend/src/pages/portfolio-forward-income/`

```
ForwardIncomePanel.tsx           — orchestrator
├── ForwardIncomeStatsRow.tsx    — 4 MetricStat cards: projAnnual CAD, forward yield %, forward yield-on-cost %, computedAt
├── ForwardIncomeTable.tsx       — sortable per-security table
├── UpcomingCalendarStrip.tsx    — 90d horizontal scroller
├── ByTaxStatusBreakdown.tsx     — taxStatus × currency matrix
├── ByAssetTypeBreakdown.tsx     — assetType × currency matrix
└── CaveatsBanner.tsx            — unreliable + no-history list, collapsible
```

**ForwardIncomeTable columns:** symbol (logo + ticker), qty, projAnnual (native), projAnnual (CAD), forwardYield %, forwardYieldOnCost %, cadence badge, unreliable indicator.

- Default sort: projectedAnnualIncomeCad desc.
- Sortable: symbol, projAnnual native/CAD, forwardYield, forwardYieldOnCost, cadenceLabel.
- Filter toggle: "Hide unreliable" (default off).
- Symbol cell → `/portfolio/security/:id` (Slice F drill).

**UpcomingCalendarStrip:**
- Horizontal scrollable strip, chronologically left-to-right.
- Each chip: date (e.g. "Jun 15"), symbol, estimatedTotalCad.
- Click chip → `/portfolio/security/:id`, scrolls to DividendHistoryCard.
- Empty state: "No payments expected in next 90 days."

**ByTaxStatusBreakdown / ByAssetTypeBreakdown:**
- Reuse BucketCard pattern from Slice D ([portfolio-account-type/BucketCard.tsx](frontend/src/pages/portfolio-account-type/BucketCard.tsx)).
- Row per bucket: label + per-currency mini-table + total CAD.
- Side-by-side responsive layout; stacked on narrow widths.

**CaveatsBanner:**
- Hidden when no caveats.
- Lists unreliable security symbols + reason.
- Lists holdings-without-history with reason.
- Collapsible.

### 5.3 Types

Re-export `PortfolioForwardIncome` and inline types in [frontend/src/types/api.ts](frontend/src/types/api.ts) alongside existing `Portfolio*` re-exports.

### 5.4 Loading + error

- Loading skeleton: 4 stat cards + table-shimmer + 1 strip placeholder.
- Error: toast + retry button (existing `useApiFetch` pattern).
- Empty: stat cards all $0, table empty-state row "No income-generating holdings yet."

## 6. Testing

### 6.1 Backend unit — `backend/test/portfolio/forwardIncome.test.ts`

- `inferCadence`: monthly ETF (12 events) → cadenceLabel='monthly', annualPerShare=sum, medianSpacingDays≈30, cvPct from variance.
- `inferCadence`: quarterly stock (4 events) → cadenceLabel='quarterly'.
- `inferCadence`: semiannual bond (2 events) → 'semiannual'.
- `inferCadence`: 12 events with CV>0.5 → cadenceLabel='monthly' (count drives label), cvPct returned for `unreliable` flag.
- `inferCadence`: 7 events (gap pattern) → cadenceLabel='irregular'.
- `inferCadence`: zero events → 'none', annualPerShare=0, cvPct=null.
- `inferCadence`: 1 event → 'annual' (count=1), cvPct=null.
- `inferCadence`: 3 events → 'quarterly', cvPct=null (insufficient for CV).
- `projectNextEvents`: monthly cadence 90d horizon → 3 entries.
- `projectNextEvents`: quarterly cadence 90d → 1 entry.
- `projectNextEvents`: medianSpacingDays > horizon → 0 entries.
- `computeForwardProjection`: dividend-only security.
- `computeForwardProjection`: interest-only security (bond).
- `computeForwardProjection`: both dividend + interest combined.
- `computeForwardProjection`: qty=0 → projectedAnnualIncomeNative=0.
- `computeForwardProjection`: foreign currency security (USD) — currency passthrough.

### 6.2 Backend builder — `backend/test/portfolio/forwardIncomeBuilder.test.ts`

- Greenfield household: holdings exist, no projection rows yet → rebuild creates one row per held security.
- Rebuild after activity change: existing row updated, stale_at cleared.
- Securities no longer held: rows deleted.
- Multi-household isolation: rebuilding A doesn't touch B.
- `rebuildForwardProjectionsForAllHouseholds`: iterates correctly, aggregates counts.

### 6.3 Backend stale invalidation — `backend/test/portfolio/forwardIncomeStale.test.ts`

- `InvestmentActivity.create` with `activityType='interest'` → matching row marked stale.
- `InvestmentActivity.create` with `activityType='buy'` → matching row marked stale (qty changed).
- `SecurityDividend.upsert` → all rows for that securityId across all households marked stale.
- `HoldingSnapshot.create` → matching household+security row marked stale.
- Stale row triggers lazy rebuild on endpoint read; subsequent read returns fresh data without further stale_at.

### 6.4 Backend scheduler — `backend/test/portfolio/forwardIncomeScheduler.test.ts`

- `runForwardIncomeTick` with feature flag off → status='skipped_disabled'.
- `runForwardIncomeTick` rebuilds all households, returns counts.
- Re-entrancy guard prevents overlapping ticks.
- Cron expression validated; invalid → logger.error + return null.

### 6.5 Backend integration — `backend/test/integration/portfolioForwardIncome.test.ts`

- `GET /api/portfolio/forward-income`: full payload shape.
- Household isolation: caller's household only.
- Cross-household 403.
- 401 unauthenticated.
- FX conversion correctness for USD holdings.
- Empty household returns all-zero structure.
- byTaxStatus matrix rollup correctness.
- byAssetType matrix rollup correctness.
- upcoming90d sort order ascending by date.
- Lazy rebuild: insert activity → endpoint read returns updated projection.
- Performance smoke: 50-security fixture asserts response < 200ms p95 (3 runs).

### 6.6 Migration — `backend/test/migrations/forwardIncomeMigration.test.ts`

- Up creates table + indexes + UNIQUE constraint.
- Down drops cleanly.
- UNIQUE (household_id, security_id) enforced on duplicate insert.

### 6.7 Frontend — `frontend/src/pages/portfolio-forward-income/*.test.tsx`

- `ForwardIncomePanel.test.tsx`: loading skeleton, error retry, empty state, data render.
- `ForwardIncomeTable.test.tsx`: default sort, column sort toggle, hide-unreliable filter, drill cross-link click.
- `UpcomingCalendarStrip.test.tsx`: chronological order, click → drill, empty state.
- `ByTaxStatusBreakdown.test.tsx`: matrix render, per-currency rows, total CAD rollup.
- `ByAssetTypeBreakdown.test.tsx`: parallel coverage.
- `CaveatsBanner.test.tsx`: hidden when empty, expand/collapse, reason text.

## 7. Open questions

None remaining from brainstorm — all locked in §2. Surfacing two implementation-time items for the plan:

1. **Sequelize hook implementation pattern**: this codebase has no precedent for invalidation hooks; the plan should establish a `backend/src/hooks/` directory or co-locate hooks in model files. Decision deferred to plan.
2. **`fx_rates` accessor reuse**: confirm [metrics.ts](backend/src/portfolio/metrics.ts) exports an FX lookup helper or extract one during plan.

## 8. Out of scope

- Income from cash-equivalent accounts (savings/HISA) — only investment-account holdings.
- Tax-withholding-adjusted "net" income — projections are gross.
- Multi-currency dividend reinvestment scenarios — assumes cash payout.
- Per-account drill within the forward income tab — securities aggregate household-wide.
- Dividend growth modeling (DGR projection) — flat last-payment assumption.
- "Income calendar" beyond 90 days — defer to v2 with toggle.
- Custom user-overridable cadence/amount per holding (e.g. for GICs with known maturity) — defer.
- Backtest / historical-projection-accuracy view — table schema supports it later but no UI in v1.
