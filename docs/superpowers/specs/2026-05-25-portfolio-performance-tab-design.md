# Slice B — Portfolio Performance Tab

**Status:** Design spec. Sixth slice from the [Portfolio Enrichment Umbrella](./2026-05-24-portfolio-enrichment-vision.md).
**Date:** 2026-05-25
**Scope:** Single PR (large). New `portfolio_daily_snapshots` table (per-household per-account per-day MV with FX audit), nightly cron rebuilder, Sequelize-hook stale invalidation, `households.benchmark_symbol` column with `PATCH /api/household/benchmark` endpoint, `GET /api/portfolio/performance` endpoint backing a new **Performance** tab (between Holdings and By security) with TWR/MWR stats, daily-value chart, benchmark overlay, per-account TWR table, and caveats banner.

---

## 1. Goal

Answer "how am I doing?" — chart total CAD portfolio value over time, overlay a configurable benchmark (default SPY, currency-converted with historical FX), and surface time-weighted + money-weighted returns over preset ranges (1M/3M/YTD/1Y/All) plus a custom range picker. Per-account TWR breakdown lets the user see which accounts drove or dragged the headline number.

## 2. Decisions locked from the brainstorm

| Question | Decision |
|---|---|
| Snapshot granularity | Per-account per-day (`UNIQUE (household_id, account_id, date)`). Household totals derived via `SUM(market_value_cad) GROUP BY date`. |
| Retention | Forever. No purge cron. Storage ~91k rows per household for 5yr backfill of 50 accounts; trivial. |
| Backfill strategy | Reconstruct from `investment_activities` ledger + `security_daily_prices.adj_close`. Walk dates forward, maintain running per-(account, security) qty. |
| Cash flow definition | `activityType='transfer'` only. Dividends/interest/buys/sells = internal (don't break time-weight). Industry-standard TWR convention. |
| Benchmark default + config | Default `SPY`. Per-household override via `households.benchmark_symbol` column. Edited via `PATCH /api/household/benchmark` from a card on the Performance tab. |
| FX schema | Store all three: `market_value_native`, `fx_rate_to_cad`, `market_value_cad` per row. Honest history + audit trail + O(1) reads. |
| TWR period | Fixed presets (1M / 3M / YTD / 1Y / All) **plus** custom date range picker. Endpoint always returns `presetStats` AND `stats` for selected range. |
| Snapshot trigger | Nightly cron only at 03:00 (offset from Slice C's 02:00 to serialize). No lazy-on-read. No on-import trigger. |
| Tab placement | Right after Holdings. New order: Holdings · **Performance** · By security · Allocation · By account type · Income · Forward income · Realized P&L. |

## 3. Today's state (recap)

- `investment_activities` table holds all transaction events. `activityType='transfer'` covers deposits/withdrawals (CONT/AFT/P2P/E_TRF variants per `wealthsimpleTxnType.ts`).
- `security_daily_prices` table holds daily OHLCV (from Slice F). `ensureDailyPrices(securityId)` lazily backfills 20yr history from AV `TIME_SERIES_DAILY_ADJUSTED`.
- `fx_rates` table holds daily exchange rates. `ensureFxRate(from, to, date)` lazily backfills from Bank of Canada.
- `Household` model has only `id` + `name` + timestamps. No settings/config columns yet.
- `Security` model holds tickers; benchmark = just another row.
- `node-cron` scheduler infra established by Slice C ([forwardIncomeScheduler.ts](backend/src/portfolio/forwardIncomeScheduler.ts)).
- Sequelize hook pattern with `transaction.afterCommit` + `setImmediate` deferral established by Slice C ([forwardIncomeStaleHooks.ts](backend/src/hooks/forwardIncomeStaleHooks.ts)) to avoid SQLITE_BUSY during bulk imports.
- No existing TWR/IRR/XIRR math. No portfolio-value-over-time infrastructure. No household-level settings beyond `name`.

## 4. Backend

### 4.1 New table — `portfolio_daily_snapshots`

Migration `backend/src/migrations/20260529000001-portfolio-daily-snapshots.js`:

```sql
CREATE TABLE portfolio_daily_snapshots (
  id                       BIGSERIAL PRIMARY KEY,
  household_id             BIGINT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id               BIGINT NOT NULL REFERENCES accounts(id)   ON DELETE CASCADE,
  date                     DATE   NOT NULL,

  market_value_native      DECIMAL(20,4) NOT NULL,
  currency                 VARCHAR(8)    NOT NULL,
  fx_rate_to_cad           DECIMAL(12,6) NOT NULL,   -- 1.0 for CAD accounts
  market_value_cad         DECIMAL(20,4) NOT NULL,   -- precomputed = native × fx_rate_to_cad

  cash_flow_native         DECIMAL(20,4) NOT NULL DEFAULT 0,  -- net transfer-type activities that day
  cash_flow_cad            DECIMAL(20,4) NOT NULL DEFAULT 0,

  is_partial               BOOLEAN NOT NULL DEFAULT false,    -- true when any security lacks daily price OR FX missing
  missing_data_reasons     JSONB,                              -- ['no_price:AAPL','no_fx:USD-2024-01-15']; null when not partial

  computed_at              TIMESTAMP NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_pds_household_account_date UNIQUE (household_id, account_id, date)
);

CREATE INDEX idx_pds_household_date ON portfolio_daily_snapshots (household_id, date);
CREATE INDEX idx_pds_account_date   ON portfolio_daily_snapshots (account_id, date);
```

Use `isPostgres ? Sequelize.JSONB : Sequelize.JSON` for `missing_data_reasons` per repo convention.

### 4.2 New column — `households.benchmark_symbol`

Migration `backend/src/migrations/20260529000002-households-benchmark-symbol.js`:

```sql
ALTER TABLE households
  ADD COLUMN benchmark_symbol VARCHAR(16) NOT NULL DEFAULT 'SPY';
```

Existing rows backfill to `'SPY'`.

### 4.3 Pure helpers — `backend/src/portfolio/returns.ts`

```ts
export interface DailyPoint {
  date: string;             // 'YYYY-MM-DD'
  marketValueCad: number;
  cashFlowCad: number;      // signed: + deposit, − withdrawal; occurs at START of this point's day
}

export function computeTwr(points: DailyPoint[]): number;
//   - Returns 0 if fewer than 2 points OR points[0].marketValueCad === 0.
//   - Sub-period chain: for i in 1..n-1:
//       r_i = (MV[i] − cashFlow[i]) / MV[i-1] − 1
//     (cashFlow on day i is added to MV[i] but should not count as return)
//   - TWR = (∏ (1 + r_i)) − 1, then multiplied by 100 (repo *Pct convention).

export interface IrrCashFlow {
  date: string;
  amount: number;            // signed: deposits NEGATIVE (money in), withdrawals POSITIVE (money out), final MV POSITIVE.
}

export function computeXirr(cashFlows: IrrCashFlow[], guess?: number): number | null;
//   Newton-Raphson on NPV(rate) = Σ amount_i / (1 + rate)^((date_i − date_0)/365.25) = 0
//   - guess defaults to 0.10 (10%).
//   - Returns annualized rate × 100 (repo *Pct convention).
//   - Returns null if no convergence after 50 iterations or NPV derivative too small.

export function buildCashFlowSeries(
  snapshots: PortfolioDailySnapshotRow[],   // ordered by date asc; aggregated per-day across accounts
  finalMvCad: number,
): IrrCashFlow[];
//   - First entry: { date: snapshots[0].date, amount: -snapshots[0].marketValueCad } (initial money-in)
//   - Per-day cash flow entries: any day where cashFlowCad ≠ 0 → { date, amount: -cashFlowCad } (deposit = negative)
//   - Final entry: { date: lastDay, amount: finalMvCad } (final money-out)

export function computeBenchmarkSeries(
  benchmarkDailyPrices: Array<{ date: string; adjClose: number }>,
  fxByDate: Map<string, number>,            // benchmark currency → CAD per date; 1.0 for CAD benchmarks
  initialPortfolioValueCad: number,         // anchor for normalization
): Array<{ date: string; valueCad: number }>;
//   - "Buy-and-hold" simulation: at date[0], buy enough benchmark shares to equal initialPortfolioValueCad.
//     fixedShares = initialPortfolioValueCad / (adjClose[0] × fx[0])
//   - For each subsequent date: valueCad = fixedShares × adjClose × fx
//   - Returns same length as input; missing fx_rate defaults to previous-day's fx (forward-fill).
```

All pure. No DB. No I/O.

### 4.4 Builder — `backend/src/portfolio/dailySnapshotBuilder.ts`

```ts
export interface BuildDailySnapshotsArgs {
  householdId: number;
  fromDate?: string;   // default: earliest activity tradeDate for household; or (last_snapshot.date + 1) if any exist
  toDate?: string;     // default: yesterday's date (end-of-day snapshots)
}

export interface BuildResult {
  daysBuilt: number;
  daysSkipped: number;
  partialDays: number;
  errors: string[];
}

export async function buildDailySnapshotsForHousehold(args: BuildDailySnapshotsArgs): Promise<BuildResult>;
//   1. Load household investment accounts.
//   2. Load ALL activities for those accounts (ordered by tradeDate asc).
//   3. Resolve effective fromDate / toDate.
//   4. Identify touched securityIds; call ensureDailyPrices(id) once each (kicks off lazy backfill).
//   5. Identify non-CAD currencies in scope; ensure fx_rate present for each (currency, date) via ensureFxRate.
//   6. Walk dates asc from fromDate to toDate:
//      - Update per-(account, security) qty map by applying activities at this tradeDate.
//      - For each account:
//        - For each held security with qty > 0:
//          - Lookup adj_close from security_daily_prices for (security, date). If missing, flag is_partial + add 'no_price:SYMBOL' to reasons.
//          - mv_native += qty × adj_close
//        - Lookup fx_rate_to_cad for (account.currency, date). If missing, flag is_partial + add 'no_fx:CUR-DATE' to reasons.
//        - mv_cad = mv_native × fx_rate_to_cad (or 0 if both missing)
//        - cash_flow_native = sum of activities at (account, date) where activityType='transfer'
//        - cash_flow_cad = cash_flow_native × fx_rate_to_cad
//        - upsert row with conflictFields: ['household_id', 'account_id', 'date']
//   7. Return counts.

export async function buildDailySnapshotsForAllHouseholds(args?: { toDate?: string }): Promise<{
  households: number;
  daysBuilt: number;
  daysSkipped: number;
  partialDays: number;
}>;
//   Iterates Household.findAll, calls per-household. Used by nightly cron.

export async function markDailySnapshotsStaleForHousehold(
  householdId: number,
  fromDate: string,
): Promise<void>;
//   DELETE FROM portfolio_daily_snapshots WHERE household_id = $1 AND date >= $2.
//   Next builder run will recreate.
```

**Note on activity walking:** the running qty map starts at 0 for every (account, security). The first activity for that pair establishes the qty trajectory. Holdings_snapshots are NOT used as starting state in v1; if a user imports broker statements without underlying activity rows (rare given the project's design), the snapshot value will read 0 from that account's perspective — surface via `is_partial` and a `no_activity_history:account_X` reason.

### 4.5 Stale hooks — `backend/src/hooks/dailySnapshotStaleHooks.ts`

```ts
let registered = false;

export function registerDailySnapshotStaleHooks(_sequelize: Sequelize): void {
  if (registered) return;
  registered = true;

  const deferOrRun = (opts: { transaction?: Transaction } | undefined, work: () => Promise<void>) => {
    if (opts?.transaction) {
      opts.transaction.afterCommit(() => setImmediate(() => void work()));
      return;
    }
    return work();
  };

  InvestmentActivity.addHook('afterCreate', 'daily_snapshot_stale_create', async (instance, opts) => {
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await deferOrRun(opts, () => markDailySnapshotsStaleForHousehold(hhId, instance.tradeDate));
  });

  InvestmentActivity.addHook('afterUpdate', 'daily_snapshot_stale_update', async (instance, opts) => {
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    // Use earlier of (old tradeDate, new tradeDate) to cover both directions
    const newDate = instance.tradeDate;
    const oldDate = instance.previous('tradeDate') as string | undefined;
    const fromDate = oldDate && oldDate < newDate ? oldDate : newDate;
    await deferOrRun(opts, () => markDailySnapshotsStaleForHousehold(hhId, fromDate));
  });

  InvestmentActivity.addHook('afterDestroy', 'daily_snapshot_stale_destroy', async (instance, opts) => {
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await deferOrRun(opts, () => markDailySnapshotsStaleForHousehold(hhId, instance.tradeDate));
  });
}
```

Wired in `backend/src/models/index.ts` after all `init*()` calls, alongside `registerForwardIncomeStaleHooks`.

`HoldingSnapshot` does NOT get a hook in v1. Activity ledger is the source of truth.

### 4.6 Scheduler — `backend/src/portfolio/dailySnapshotScheduler.ts`

Same shape as `forwardIncomeScheduler.ts`:

```ts
export interface DailySnapshotTickResult {
  status: 'skipped_disabled' | 'ran' | 'error';
  householdsProcessed?: number;
  daysBuilt?: number;
  daysSkipped?: number;
  partialDays?: number;
  error?: string;
}

export async function runDailySnapshotTick(configOverride?: Partial<{ enabled: boolean }>): Promise<DailySnapshotTickResult>;
export function startDailySnapshotScheduler(): ScheduledTask | null;
export function stopDailySnapshotScheduler(): void;
```

- Cron expression: `0 3 * * *` (03:00 local), env-overridable via `DAILY_SNAPSHOT_CRON`.
- Feature flag: `DAILY_SNAPSHOT_ENABLED` (default true outside `test`).
- Re-entrancy guard via module-level `runningTick`. `stopDailySnapshotScheduler` resets it.
- Logs `daily_snapshot_tick` with counts.

Wired in `backend/src/server.ts` adjacent to `startQuoteScheduler()` and `startForwardIncomeScheduler()`.

### 4.7 New endpoint — `GET /api/portfolio/performance`

Authenticated, household-scoped via `currentAuth(req).household`.

Query params:
- `range`: `'1M' | '3M' | 'YTD' | '1Y' | 'All' | 'custom'` (default `'1Y'`)
- `from`, `to`: required when `range='custom'`, format `YYYY-MM-DD`; ignored otherwise

Response (`shared/api-types.ts`):

```ts
export type PortfolioPerformanceRange = '1M' | '3M' | 'YTD' | '1Y' | 'All' | 'custom';

export type PortfolioPerformancePoint = {
  date: string;
  portfolioValueCad: number;
  benchmarkValueCad: number;
  isPartial: boolean;
};

export type PortfolioPerformanceStats = {
  twrPct: number;                  // *100 scale
  mwrPct: number | null;           // null if XIRR didn't converge
  benchmarkTwrPct: number;
  vsBenchmarkDeltaPct: number;     // twrPct − benchmarkTwrPct
  startDate: string;
  endDate: string;
  startValueCad: number;
  endValueCad: number;
  netCashFlowCad: number;
};

export type PortfolioPerformanceByAccount = {
  accountId: number;
  accountName: string;
  twrPct: number;
  endValueCad: number;
  weightInPortfolioPct: number;    // accountEndValue / portfolioEndValue × 100
};

export type PortfolioPerformanceCaveats = {
  partialDaysCount: number;
  missingDataReasons: string[];    // distinct; capped at 20
  benchmarkSymbol: string;
  benchmarkIsPartial: boolean;
};

export type PortfolioPerformance = {
  range: PortfolioPerformanceRange;
  stats: PortfolioPerformanceStats;
  presetStats: {
    '1M': PortfolioPerformanceStats;
    '3M': PortfolioPerformanceStats;
    'YTD': PortfolioPerformanceStats;
    '1Y': PortfolioPerformanceStats;
    'All': PortfolioPerformanceStats;
  };
  series: PortfolioPerformancePoint[];
  byAccount: PortfolioPerformanceByAccount[];
  caveats: PortfolioPerformanceCaveats;
};
```

**Endpoint flow:**
1. Resolve `from` / `to` from `range` param. `'All'` → earliest snapshot date for household; `'YTD'` → Jan 1 current year; `'1Y'`/`'3M'`/`'1M'` → N days back. 400 if `range='custom'` without `from`/`to`.
2. Load `portfolio_daily_snapshots` for household over a date range covering the selected range AND all preset ranges (use `min(allFromDates)`).
3. Load benchmark `Security` row by `household.benchmark_symbol`. If absent, attempt `Security.findOne({ where: { symbol } })`; if absent, create one (lazy) + fire `ensureDailyPrices`. If still no rows, mark `caveats.benchmarkIsPartial=true` + return empty benchmark series.
4. Load `security_daily_prices` for benchmark over the broadest date range.
5. Load `fx_rates` for benchmark currency over date range; build `fxByDate` map.
6. For selected range + each preset range:
   - Aggregate `snapshots` by `date` to get per-day household totals + per-day total cash flow.
   - Call `computeTwr(points)`.
   - Call `buildCashFlowSeries` + `computeXirr` for MWR.
   - Call `computeBenchmarkSeries` with `initialPortfolioValueCad = points[0].marketValueCad`.
   - Compute `benchmarkTwrPct` from benchmark series.
   - Assemble `PortfolioPerformanceStats`.
7. Build `byAccount`: per account, filter snapshots, run `computeTwr`, compute weight at end-date.
8. Build `series` for selected range only (join household totals with benchmark series on date).
9. Build `caveats`: count `is_partial` rows; collect distinct `missing_data_reasons` (capped 20); read `household.benchmark_symbol`; detect if benchmark series has gaps.

**Empty state:** Household with no investment accounts OR no snapshot rows → return all-zero structure (all stats values 0, series=[], byAccount=[], presetStats all zero, benchmarkSymbol from household).

### 4.8 New endpoint — `PATCH /api/household/benchmark`

```ts
// Request body
{ benchmarkSymbol: string }   // 1-16 chars

// Response 200
{ benchmarkSymbol: string }
```

Behavior:
- Validate symbol shape (1-16 alphanumeric + `.` allowed).
- `Security.findOrCreate({ where: { symbol, householdId: <auth.household.id> } })` — benchmark gets a Security row in the user's household scope for the lazy-backfill machinery.
- `ensureDailyPrices(security.id)` fires (non-blocking) to start backfill.
- Update `household.benchmark_symbol = symbol`.
- 400 if symbol fails shape validation.

If a separate household-settings endpoint already exists, prefer extending it; otherwise create this minimal one.

## 5. Frontend

### 5.1 Tab integration

In [PortfolioPage.tsx](frontend/src/pages/PortfolioPage.tsx):

```ts
type TabKey = 'holdings' | 'performance' | 'by-security' | 'allocation' | 'by-account-type' | 'income' | 'forward-income' | 'realized';

const TAB_ITEMS: TabItem[] = [
  { value: 'holdings', label: 'Holdings' },
  { value: 'performance', label: 'Performance' },
  { value: 'by-security', label: 'By security' },
  // ... rest unchanged
];
```

New `<TabPanel value="performance"><PerformancePanel /></TabPanel>`.

### 5.2 Component tree — `frontend/src/pages/portfolio-performance/`

```
PerformancePanel.tsx              — orchestrator; lazy fetch on tab activation; URL syncs `range` param
├── PerformanceStatsRow.tsx       — 5 preset stat cards (1M / 3M / YTD / 1Y / All) + optional custom range card
├── PerformanceChart.tsx          — recharts line: portfolio CAD + benchmark CAD overlay
├── PerformanceRangeToggle.tsx    — buttons: 1M | 3M | YTD | 1Y | All | Custom
├── CustomRangePicker.tsx         — two date inputs; visible when range='custom'
├── ByAccountTable.tsx            — per-account TWR table; sortable
├── BenchmarkPickerCard.tsx       — current symbol; edit button → dialog; PATCH on save
└── PerformanceCaveatsBanner.tsx  — partial-day count + missing-data list; collapsible
```

### 5.3 Behavior details

**`PerformancePanel`:**
- `useSearchParams` for `range` (and `from`/`to` when custom)
- Re-fetches on `range` / `from` / `to` change
- Standard loading / error / empty states (matching Slice C `ForwardIncomePanel`)

**`PerformanceChart`:**
- Library: recharts (already used in [PriceChartCard.tsx](frontend/src/pages/portfolio-security/PriceChartCard.tsx) per Slice F)
- Two line series: portfolio (brand primary, solid), benchmark (muted, dashed)
- X-axis: date, tick spacing scaled to range length
- Y-axis: CAD with abbreviation (`$10K`, `$1.2M`)
- Tooltip on hover: date + portfolio value + benchmark value + delta % since range start
- Partial-day visual: semi-transparent stroke for those segments

**`PerformanceStatsRow`:**
- 5 always-on cards using `presetStats`
- Each card: large TWR%, smaller "vs SPY: ±X.XX%" below, color green/red by sign
- Custom range adds a 6th card with same shape

**`ByAccountTable`:**
- Columns: Account name | End value CAD | Weight % | TWR % (over selected range)
- Default sort: end-value desc; sortable columns
- Account name renders as plain text in v1 (drill link deferred)

**`BenchmarkPickerCard`:**
- Shows "Benchmark: SPY" + edit button
- Edit dialog: text input for ticker, validation
- Save → `PATCH /api/household/benchmark`, then refetch performance
- Show warning if ticker lacks daily price history (backfill in progress)

**`PerformanceCaveatsBanner`:**
- Hidden when `partialDaysCount === 0 && !benchmarkIsPartial`
- Header: "X days have incomplete data" + benchmark warning
- Collapsible list of `missingDataReasons` (up to 20)

### 5.4 Types

Re-export all `PortfolioPerformance*` types in [frontend/src/types/api.ts](frontend/src/types/api.ts) alongside existing `Portfolio*` re-exports, matching pattern set by Slice C.

## 6. Testing

### 6.1 Backend unit — `backend/test/portfolio/returns.test.ts`

Node:test idiom. Pure helpers:
- `computeTwr`: empty/single point → 0; two equal-value points → 0; price doubles → 100; deposit mid-period doesn't distort TWR; withdrawal mid-period; multi-period chain math; zero starting MV → 0
- `computeXirr`: single-deposit + final → matches Excel XIRR; multi-deposit DCA; withdrawal mid-stream; negative return; zero cash flows → null; non-converging → null
- `buildCashFlowSeries`: empty snapshots → just initial+final; with transfers → flows inserted; signs correct (deposits negative, final MV positive)
- `computeBenchmarkSeries`: flat prices → flat series at initialPortfolioValueCad; doubling prices → doubling series; mixed FX over time

### 6.2 Backend builder — `backend/test/portfolio/dailySnapshotBuilder.test.ts`

Per-file sqlite + node:test, inline factories. Cases:
- Greenfield: 1 household, 1 account, 1 security, 5 days of activity → 5 snapshot rows
- Multi-account, same security → 2 snapshot rows per day
- USD account → `fx_rate_to_cad` populated from `fx_rates`; `market_value_cad = native × fx`
- Missing daily price → `is_partial=true`, reason includes `no_price:SYMBOL`
- Missing FX → `is_partial=true`, reason includes `no_fx:USD-2024-...`
- Transfer activity on day D → `cash_flow_native = amount` on D's row
- Buy on D → no cash_flow; qty changes from D forward
- Sell + buy same day → end-of-day MV reflects net qty
- Re-run is idempotent (upsert) — same date range twice = same row count
- `fromDate` defaults to earliest activity when no snapshots exist
- `fromDate` defaults to `lastSnapshot.date + 1` when snapshots exist
- `markDailySnapshotsStaleForHousehold(hh, '2024-06-01')` deletes rows >= that date
- `buildDailySnapshotsForAllHouseholds` iterates households + aggregates counts

### 6.3 Backend stale hooks — `backend/test/portfolio/dailySnapshotStale.test.ts`

- `InvestmentActivity.create(type='transfer', tradeDate='2024-06-15')` → deletes rows for household where date >= '2024-06-15'
- `InvestmentActivity.update` (changing tradeDate) → deletes from earlier of (old, new)
- `InvestmentActivity.destroy` → deletes from that tradeDate forward
- Hook fires inside `transaction.afterCommit` (no SQLITE_BUSY on bulk import)
- Idempotent re-registration guard
- Unrelated household activity → no cross-household deletes

### 6.4 Backend scheduler — `backend/test/portfolio/dailySnapshotScheduler.test.ts`

- `runDailySnapshotTick({ enabled: false })` → `status='skipped_disabled'`
- `runDailySnapshotTick({ enabled: true })` with one household → builds snapshots, returns counts
- Sequential ticks idempotent
- `stopDailySnapshotScheduler` resets `runningTick`

### 6.5 Backend integration — `backend/test/integration/portfolioPerformance.test.ts`

- 401 unauthenticated
- Empty household → all-zero structure, presetStats present, `benchmarkSymbol='SPY'`
- Single-account 1Y history → `stats.twrPct` matches manual calc; `series` length matches range
- USD account → benchmark CAD conversion correct
- `range='custom'` with `from`/`to` → series clipped; stats computed over that range; 400 if `from`/`to` missing
- `range='YTD'` → series starts Jan 1
- Benchmark missing daily prices → `caveats.benchmarkIsPartial=true`
- Per-account TWR sums weighted correctly
- `PATCH /api/household/benchmark` updates `households.benchmark_symbol`; next GET reflects new symbol
- Cross-household 403/isolation
- Perf smoke: 50-account household, 1Y range → response < 500ms p95 (3 sample runs)

### 6.6 Migration tests

- `backend/test/migrations/portfolioDailySnapshotsMigration.test.ts`: up creates table + indexes + UNIQUE; down drops cleanly
- `backend/test/migrations/householdsBenchmarkSymbolMigration.test.ts`: up adds column with default 'SPY'; down drops

### 6.7 Frontend — `frontend/src/pages/portfolio-performance/*.test.tsx`

Vitest + @testing-library/react:
- `PerformancePanel.test.tsx`: loading, error retry, empty, data render, range switch refetch
- `PerformanceStatsRow.test.tsx`: 5 cards, color by sign, benchmark delta
- `PerformanceChart.test.tsx`: 2 lines, tooltip data, partial-day signal
- `PerformanceRangeToggle.test.tsx`: button state, URL sync
- `ByAccountTable.test.tsx`: default sort end-value desc, weight %, sortable
- `BenchmarkPickerCard.test.tsx`: opens dialog, validates, PATCH on save
- `PerformanceCaveatsBanner.test.tsx`: hidden when no caveats, expand/collapse
- `CustomRangePicker.test.tsx`: from < to validation, apply triggers URL change

## 7. Open questions

None remaining from the brainstorm. Surfacing two implementation-time items for the plan:

1. **`PATCH /api/household/benchmark` vs existing settings route**: confirm during plan phase whether a `PATCH /api/household` or `PATCH /api/household/settings` route already exists. If yes, extend it; if not, ship the minimal dedicated endpoint above.
2. **`previous('tradeDate')` API on Sequelize instance**: the stale hook for `afterUpdate` needs the prior value. Confirm Sequelize 6 exposes this via `instance.previous('field')` (it does, but verify behavior under TS strict mode).

## 8. Out of scope

- Per-security return attribution / contribution analysis (was rejected during scope-check; revisit as Slice B.1 if demand appears)
- Per-holding TWR drill page (deferred; user can use Slice F's per-security detail page for now)
- Tax-aware "after-tax return" view (out of umbrella per `vision.md` §9)
- Sub-daily intraday charts (out of umbrella; AV free tier lacks data)
- Reinvested dividends modeled differently from internal flow (locked: dividends = internal per industry-standard TWR)
- DRIP-aware projection (Slice C territory; this slice is backward-looking only)
- Multiple simultaneous benchmark overlays (one benchmark per household in v1)
- Mobile portfolio view (umbrella-out)
- Backtest of projection accuracy (Slice C followup, not Slice B)
