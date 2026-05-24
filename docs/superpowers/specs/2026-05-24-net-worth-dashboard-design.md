# Net Worth Dashboard — Design

**Date:** 2026-05-24
**Status:** Draft (awaiting user review)
**Author:** Connor Adams
**Context:** New dashboard that surfaces total net worth (assets − liabilities) over time, layered on existing Cashflow accounts, transactions, and portfolio data.

---

## Goals

1. Show current net worth as a single CAD-unified figure, with composition broken down by account and asset/liability kind.
2. Plot net worth as a time series (monthly default, daily for last 90 days) using existing transaction history and portfolio market values — no manual data entry required for MVP.
3. Add a compact headline tile to the existing `DashboardPage` that links to the full view.
4. Lay down an extensible aggregator (contributor pattern) so future asset / liability types (manual entries: real estate, mortgage, vehicle, off-platform crypto) plug in without re-architecting.

Non-goals (MVP): manual `ManualWealthEntry` table; pre-aggregated snapshots; multi-currency display modes (CAD only for headline); scenarios / projections; tax-aware net worth (post-tax adjustments live in the existing tax tab).

---

## Constraints

- **Local-first single-user-ish app.** Personal data volumes (txns: ~10⁴–10⁵, accounts: <50). Compute strategy must be simple, not optimised for scale.
- **Existing edit patterns.** Transactions are constantly re-classified (rules re-apply, splits change, AI suggestions). Pre-aggregated snapshots are fragile against this; prefer derived values.
- **Reporting currency:** CAD. Non-CAD amounts converted via existing `FxRate` (Bank of Canada source) using the same `ensureFxRate` path that portfolio uses today.
- **Auth scope:** Household-aware. All accounts filtered via `visibleAccountWhere` — must never leak across users / households.
- **Hard-fail on missing FX or price**, never silently coerce to 1.0 or 0. Matches existing portfolio behaviour (`buildUnifiedCadTotal` returns `null` on any unresolved rate).
- **No new dependencies.** Use existing chart lib + UI primitives that PortfolioPage already uses.

---

## Architecture

Three layers, mirroring the tax / portfolio shape already in the repo:

```
┌──────────────────────────────────────────────────────────────────┐
│  UI                                                              │
│  • frontend/src/pages/NetWorthPage.tsx       (full page)         │
│  • frontend/src/components/dashboard/NetWorthTile.tsx (compact)  │
└────────────────────────────────┬─────────────────────────────────┘
                                 │ REST
┌────────────────────────────────▼─────────────────────────────────┐
│  API: backend/src/routes/netWorth.ts                             │
│  GET   /api/net-worth/current                                    │
│  GET   /api/net-worth/series?from&to&granularity                 │
│  PATCH /api/accounts/:id/opening-balance                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│  Aggregator: backend/src/networth/aggregate.ts (pure)            │
│                                                                  │
│  buildNetWorthAt(asOf) → { total, assets, liabilities, partial } │
│                                                                  │
│  Iterates contributors:                                          │
│    • cashContributor          (asset-kind accounts)              │
│    • liabilityContributor     (liability-kind accounts)          │
│    • portfolioContributor     (HoldingSnapshot × SecurityPrice)  │
│    • (future) manualEntryContributor                             │
│                                                                  │
│  Unifies per-currency totals → CAD via ensureFxRate.             │
└──────────────────────────────────────────────────────────────────┘
```

The aggregator is a pure module — no Express, no route handlers. Contributors are async functions taking `asOf: string` and returning `{ currency: string; amount: number; kind: 'asset' | 'liability' }[]`. The aggregator collects, groups by currency, FX-unifies, and sums.

---

## Data model changes

### `Account` — two new columns

Migration adds:

```ts
declare openingBalance: CreationOptional<number>;          // default 0
declare openingBalanceDate: CreationOptional<string | null>; // ISO date; null = -infinity
```

Sequelize column definitions:

```ts
openingBalance: {
  type: DataTypes.DECIMAL(18, 4),
  field: 'opening_balance',
  allowNull: false,
  defaultValue: 0,
},
openingBalanceDate: {
  type: DataTypes.DATEONLY,
  field: 'opening_balance_date',
  allowNull: true,
  defaultValue: null,
},
```

Opening balance is stored in `account.defaultCurrency`. `null` `openingBalanceDate` means "sum all transactions for this account" — the sensible default for accounts whose CSV history covers their entire lifetime.

### No new tables for MVP

Net worth is a derived value. No `NetWorthSnapshot`, no `AccountBalanceAdjustment`. If snapshot caching or reconciliation drift becomes painful, those tables can be added later behind the same contributor contract with zero API churn.

### `accountType` → `kind` mapping

Derived in a single helper, not a new column:

```ts
// backend/src/networth/accountKind.ts
export function accountKind(accountType: string): 'asset' | 'liability' {
  switch (accountType) {
    case 'credit':
    case 'loan':
    case 'mortgage':
      return 'liability';
    case 'checking':
    case 'savings':
    case 'cash':
    case 'investment':
    default:
      return 'asset';
  }
}
```

Pre-implementation step: audit the current set of `accountType` string values in prod to confirm the switch covers them. Any unknown value defaults to `asset` — safe (never miscategorises a credit card as positive net worth) — but a warning log is emitted so we add explicit mappings as new types appear.

### Extensibility hook (post-MVP, documented for future-self)

```
ManualWealthEntry
  id            INTEGER PK
  userId        FK User
  householdId   FK Household NULL
  label         VARCHAR(120)    -- "Primary residence", "Tesla 2022"
  kind          ENUM('asset','liability')
  currency      VARCHAR(3)
  amount        DECIMAL(18,4)
  asOfDate      DATEONLY
  note          TEXT NULL
  createdAt, updatedAt
```

Adding this later = one new contributor (`manualEntryContributor`), no schema or API churn elsewhere.

---

## API

All routes under `/api/net-worth`, gated by `currentAuth` and `visibleAccountWhere` scope.

### `GET /api/net-worth/current`

Query params: `asOf?` (ISO date, defaults to today).

Response:

```ts
{
  asOf: '2026-05-24',
  baseCurrency: 'CAD',
  total: 152340.12,
  assetsTotal: 154440.12,
  liabilitiesTotal: -2100.00,
  breakdown: {
    assets: [
      { source: 'account', accountId: 1, label: 'Chequing',  currency: 'CAD', native: 12345.67, cad: 12345.67 },
      { source: 'account', accountId: 2, label: 'Savings',   currency: 'CAD', native: 50000.00, cad: 50000.00 },
      { source: 'portfolio', label: 'RRSP', currency: 'mixed', native: null, cad: 87500.00 },
      { source: 'portfolio', label: 'TFSA', currency: 'mixed', native: null, cad: 4594.45 },
    ],
    liabilities: [
      { source: 'account', accountId: 7, label: 'Visa', currency: 'CAD', native: -2100.00, cad: -2100.00 },
    ],
  },
  fxRatesUsed: [{ from: 'USD', to: 'CAD', rate: 1.36, ratedDate: '2026-05-23' }],
  partial: false,
  gaps: [],
}
```

### `GET /api/net-worth/series`

Query params:
- `from` (required, ISO date)
- `to` (required, ISO date, ≤ today; clamped silently if exceeded)
- `granularity` (`monthly` default | `daily`)

Bucket rules:
- `monthly` → last calendar day of each month in `[from, to]`. Max 240 buckets (20 years) — 400 if exceeded.
- `daily` → every date in `[from, to]`. Max 90 buckets — 400 if exceeded; response message suggests `monthly`.

Response:

```ts
{
  baseCurrency: 'CAD',
  granularity: 'monthly',
  points: [
    { date: '2025-06-30', total: 140000, assetsTotal: 142000, liabilitiesTotal: -2000 },
    { date: '2025-07-31', total: 143200, assetsTotal: 145200, liabilitiesTotal: -2000 },
    /* ... */
  ],
  partial: false,
  gaps: [],  // list of { date, currency, reason } when partial=true
}
```

### `PATCH /api/accounts/:id/opening-balance`

Lives in `netWorth.ts` (not `accounts.ts`) to keep accounts router focused. Body:

```ts
{ openingBalance: number; openingBalanceDate: string | null }
```

Validates ownership via `visibleAccountWhere`. Returns updated account row.

### Error responses

- 400 `{ error: 'asOf cannot be in the future' }` — when `asOf > today`.
- 400 `{ error: 'daily granularity limited to 90 days; use monthly' }` — when daily range exceeded.
- 400 `{ error: 'monthly granularity limited to 240 buckets' }` — when monthly range exceeded.
- 401 — unauthenticated.
- 403 — account not visible to caller (on PATCH).

---

## Compute logic

### `buildNetWorthAt(asOf)` (used by `/current` and per-bucket in `/series`)

```ts
async function buildNetWorthAt(asOf: string, scope: AccountScope): Promise<NetWorthAtDate> {
  const accounts = await Account.findAll({ where: visibleAccountWhere(scope) });

  const perCurrency: Record<string, { asset: number; liability: number }> = {};
  const breakdownAssets: BreakdownRow[] = [];
  const breakdownLiabilities: BreakdownRow[] = [];

  // Cash + liability contributors share txn-stream math
  for (const acc of accounts) {
    const kind = accountKind(acc.accountType);
    const balancesByCcy = await balanceAtDate(acc, asOf);  // see below
    for (const { currency, amount } of balancesByCcy) {
      perCurrency[currency] ??= { asset: 0, liability: 0 };
      perCurrency[currency][kind] += amount;
      (kind === 'asset' ? breakdownAssets : breakdownLiabilities).push({
        source: 'account', accountId: acc.id, label: acc.name,
        currency, native: amount, cad: null /* filled after FX */,
      });
    }
  }

  // Portfolio contributor reuses existing market-value query (with asOf-aware price lookup)
  const portfolioRows = await portfolioMarketValueAt(asOf, scope);
  for (const row of portfolioRows) {
    perCurrency[row.currency] ??= { asset: 0, liability: 0 };
    perCurrency[row.currency].asset += row.marketValue;
    breakdownAssets.push({ source: 'portfolio', label: row.accountLabel, currency: row.currency, native: row.marketValue, cad: null });
  }

  // FX-unify to CAD
  const { totalAssets, totalLiabilities, fxRatesUsed, gaps } =
    await unifyToCad(perCurrency, asOf);

  return {
    asOf,
    total: totalAssets + totalLiabilities,
    assetsTotal: totalAssets,
    liabilitiesTotal: totalLiabilities,
    breakdown: { assets: breakdownAssets, liabilities: breakdownLiabilities },
    fxRatesUsed,
    partial: gaps.length > 0,
    gaps,
  };
}
```

### `balanceAtDate(account, asOf)`

```ts
async function balanceAtDate(account: Account, asOf: string): Promise<{ currency: string; amount: number }[]> {
  const where: WhereOptions = {
    accountId: account.id,
    date: { [Op.lte]: asOf },
  };
  if (account.openingBalanceDate) {
    where.date = { [Op.gt]: account.openingBalanceDate, [Op.lte]: asOf };
  }

  const txns = await Transaction.findAll({ where, attributes: ['currency', 'amount'] });

  // Group txn deltas by currency
  const byCurrency: Record<string, number> = {};
  for (const t of txns) {
    byCurrency[t.currency] = (byCurrency[t.currency] ?? 0) + Number(t.amount);
  }

  // Opening balance lives in account.defaultCurrency
  const opening = Number(account.openingBalance) || 0;
  const defCcy = account.defaultCurrency ?? 'CAD';
  byCurrency[defCcy] = (byCurrency[defCcy] ?? 0) + opening;

  return Object.entries(byCurrency).map(([currency, amount]) => ({ currency, amount }));
}
```

### `unifyToCad(perCurrency, asOf)`

Iterates each currency, calls `ensureFxRate(ccy, 'CAD', asOf)`. On any missing rate: that currency's amounts are excluded from `totalAssets` / `totalLiabilities`, and a gap is appended:

```ts
gaps.push({ date: asOf, currency: ccy, reason: 'fx_rate_unavailable' });
```

Same hard-fail philosophy as the existing `buildUnifiedCadTotal` in `backend/src/routes/portfolio.ts`. No silent coercion.

### `portfolioMarketValueAt(asOf, scope)`

Wraps the existing portfolio market-value query, parameterised by `asOf`:
- Use latest `HoldingSnapshot` ≤ `asOf` per `(accountId, securityId)` to get the held quantity at that date.
- Use latest `SecurityPrice` ≤ `asOf` per security to get unit price.
- Market value = quantity × price.
- If no `SecurityPrice` ≤ `asOf` exists for a security, push a gap (`reason: 'price_unavailable'`) and exclude that security from the bucket.
- If no `HoldingSnapshot` ≤ `asOf` exists for an account-security pair, the position is treated as 0 at that date (the account didn't hold it yet) — no gap.

This is a new helper but extracted from the existing logic; today's portfolio routes always compute at "now" — the only addition is the date predicate on both queries. During plan-writing, confirm `HoldingSnapshot` schema has the fields needed (quantity, date, accountId, securityId) and that `SecurityPrice` is keyed by `pricedAt`.

### Series compute

```ts
async function buildSeries(from, to, granularity, scope): Promise<SeriesPoint[]> {
  const bucketDates = granularity === 'monthly'
    ? monthEndDatesInRange(from, to)
    : daysInRange(from, to);

  const points: SeriesPoint[] = [];
  for (const date of bucketDates) {
    const snap = await buildNetWorthAt(date, scope);
    points.push({
      date,
      total: snap.total,
      assetsTotal: snap.assetsTotal,
      liabilitiesTotal: snap.liabilitiesTotal,
    });
  }
  return points;
}
```

Sequential, not parallel, to stay polite to SQLite and to avoid lock contention on the read-only Sequelize transaction wrapping the request.

---

## Frontend

### `NetWorthPage` layout

```
┌─ PageHeader: "Net worth" — range picker (1M / 3M / 1Y / All)                            ┐
│                                                                                          │
│  ┌─ Headline ─────────┐  ┌─ Δ vs 30d / 1Y ──┐  ┌─ Assets vs liabilities bar ──────────┐ │
│  │ $152,340.12 CAD     │  │ +$3,200 (+2.1%)  │  │ horizontal bar, assets right, liab. │ │
│  │ as of 2026-05-24    │  │ +$18,500 (+13.8%)│  │ left, scale matched                  │ │
│  └─────────────────────┘  └──────────────────┘  └──────────────────────────────────────┘ │
│                                                                                          │
│  ┌─ Time series ─────────────────────────────────────────────────────────────────────┐  │
│  │ stacked area (cash | investments) above zero; liabilities below zero;             │  │
│  │ overlay line = total net worth                                                    │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                          │
│  ┌─ Breakdown table ─────────────────────────────────────────────────────────────────┐  │
│  │ Account | Kind | Currency | Balance (native) | CAD value | % of net worth | as of│  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                          │
│  ┌─ Account opening balances (collapsed by default) ─────────────────────────────────┐  │
│  │ Inline editor: per-account openingBalance + openingBalanceDate                    │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- Range picker: `1M`, `3M`, `1Y`, `All`. `1M` and `3M` use daily granularity. `1Y` uses monthly (12 buckets). `All` uses monthly, with `from` resolved to the earliest transaction date in any visible account (clamped to 240 buckets max — older history gets truncated with a "showing last 20 years" hint).
- Reuses `PageHeader`, `Table`, chart library, `formatCurrency` / `formatCad` helpers already used by `PortfolioPage`.

### Dashboard tile

`frontend/src/components/dashboard/NetWorthTile.tsx`:
- Headline number + 1Y monthly sparkline + Δ vs 30d
- Click → navigate to `/net-worth`
- Fetches `GET /current` and `GET /series?granularity=monthly&from=1y-ago&to=today`
- Skeleton on load, error state on fetch failure (no silent zero)

### Sidebar entry

Add "Net worth" item above "Reports" in `Sidebar.tsx`.

### Empty / partial states

- **No accounts:** CTA "Add an account to start tracking net worth" → link to Accounts page.
- **`partial: true`:** amber banner naming missing currencies / dates: e.g. "Missing FX rate for USD on 2026-05-24 — total excludes USD balances." User can act (re-fetch BoC rates) or accept.
- **Account missing `openingBalance`:** badge in breakdown row "Opening balance not set" with inline action to set it. Not an error — `0` default is sensible when CSV covers full account history.

### Loading

Skeletons on headline, chart, and breakdown — same pattern as `PortfolioPage`.

---

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| `asOf` in the future | API returns 400. |
| `to` in series in the future | Silently clamped to today. |
| Missing FX rate for some currency on `asOf` | Currency excluded from totals; `partial=true`; gap listed; banner shown in UI. Never coerced to 1.0. |
| Missing `SecurityPrice` ≤ `asOf` | Security excluded; `partial=true`; gap listed. |
| Account with no `openingBalance` set | Treated as 0 with `openingBalanceDate=null` (sum all history). Badge shown in UI. No error. |
| Account with no txns and no opening balance | Contributes 0. Silent. |
| Multi-currency account (USD txns in CAD-default account) | Each currency grouped separately; opening balance applies to `defaultCurrency` only. |
| Daily granularity over 90-day range | 400 with "use monthly". |
| Monthly granularity over 240-bucket range | 400. |
| Unknown `accountType` value | Defaults to `asset`; warn log emitted. |
| Concurrent txn edits during series request | Read-only request wrapped in a single Sequelize transaction. On Postgres the default isolation (`READ COMMITTED`) gives point-in-time consistency per statement; on SQLite the `BEGIN DEFERRED` semantics give a snapshot for the duration of the transaction. Edits during a request may produce a slightly-stale series — acceptable, no money moves. |
| Unauthenticated request | 401. |
| Cross-household account access on PATCH | 403. |

### Logging

- Warn (not error) on FX / price gaps. Format mirrors existing `[portfolio]` warns.
- No PII in logs: account IDs and dates only, never balance values.

---

## Testing

### Backend unit — `backend/src/networth/aggregate.test.ts`

Pure-function tests against in-memory SQLite (existing harness pattern).

- Single CAD checking account: opening balance + 3 txns → expected balance at 3 `asOf` dates.
- Account with `openingBalanceDate` set mid-history: txns before that date excluded from sum.
- Credit account (`accountType=credit`): classified liability, contributes negative.
- Multi-currency: USD account + CAD account → both per-currency totals returned, CAD-unified via mocked `ensureFxRate`.
- FX rate missing on `asOf`: contributor still returns the currency, aggregator marks `partial=true`, USD excluded, gap appended.
- Empty account (no txns, no opening balance): contributes 0, no warning.
- Portfolio at historical date: holding × `SecurityPrice` ≤ asOf, falls back to latest available if needed; security with no qualifying price → gap + exclusion.
- Unknown `accountType`: defaults to asset, warn log assertion.

### Backend route — `backend/src/routes/netWorth.test.ts`

- Unauthenticated → 401.
- User A cannot see User B's accounts in totals.
- `GET /current` happy path (mocked FX, seeded accounts).
- `GET /series?granularity=monthly` returns expected bucket count.
- `GET /series?granularity=daily&from=...&to=...` with > 90-day range → 400.
- `asOf` in future → 400.
- `PATCH /accounts/:id/opening-balance` updates fields; 403 when account not in scope.

### Frontend — co-located, follow existing `AiInboxPage.test.tsx` pattern

- `NetWorthPage.test.tsx`: renders headline + chart + breakdown from mocked API; loading skeleton; empty state; `partial=true` banner; range picker changes API call.
- `NetWorthTile.test.tsx`: sparkline renders from mocked series response; click navigates to `/net-worth`.

### Integration smoke — `test/networth.spec.ts` (verify project pattern during plan-writing)

- Seed 1 checking + 1 credit + 1 investment account with txns spanning 2 years.
- Hit `/api/net-worth/current` and `/api/net-worth/series?granularity=monthly`.
- Assert total = manually-computed expected value to 2 decimals.
- Assert series monotonic-ish (no missing-date-bug spikes).

### Manual verification

- After landing locally, point at prod DB → spot-check current net worth against actual bank reality. Per `feedback_use_prod_db_not_local` memory: local sqlite is a dev sandbox, prod is the only source of truth for verifying real numbers.

No `xit` / `test.skip` markers. All green before PR.

---

## Out of scope (explicit)

- `ManualWealthEntry` table and manual asset/liability rows — extensibility hook documented, not built.
- `NetWorthSnapshot` pre-aggregation — defer until on-the-fly compute proves slow.
- Multi-currency display modes — CAD-unified headline only.
- Scenarios, projections, FIRE math, life-expectancy runway — not requested.
- Tax-adjusted net worth — lives in the existing tax tab.
- Performance regression tests — add later if measurement shows pain.

---

## Open questions for plan-writing phase

- Confirm the exact set of `accountType` string values currently in prod (to flesh out `accountKind` switch beyond defaults).
- Confirm the project's e2e test entry point name and pattern (`test/*.spec.ts` vs other).
- Confirm chart library: PortfolioPage uses `<DonutSlice>`; need to identify the line/area chart component already in use elsewhere (or pick one consistent with allocation tab).
- Confirm `HoldingSnapshot` field names (expected: `accountId`, `securityId`, `quantity`, `snapshotDate`) and `SecurityPrice` keying (expected: `securityId`, `pricedAt`, `price`).
