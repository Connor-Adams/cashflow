# Slice D — Tax / Account-Type Bucket Tab

**Status:** Design spec. Fourth slice from the [Portfolio Enrichment Umbrella](./2026-05-24-portfolio-enrichment-vision.md).
**Date:** 2026-05-24
**Scope:** Single PR. New `GET /api/portfolio/by-account-type` endpoint backing a new **By account type** tab that groups holdings by `Account.taxStatus`, surfaces tax warnings (US-withholding flag, fixed-income-in-non-reg, US-payer-in-TFSA), and lists tax-loss-harvest candidates with superficial-loss-rule warnings.

---

## 1. Goal

Answer "what's in my TFSA vs RRSP vs non-reg?" and flag tax-relevant placement issues. Surface tax-loss-harvest candidates on non-registered accounts with superficial-loss-rule warnings so the user can act before year-end.

## 2. Decisions locked from the brainstorm

| Question | Decision |
|---|---|
| US-domiciled fallback when `Security.metadata.country` missing | Symbol-suffix heuristic. `.TO` / `.NEO` / `.CSE` / `.V` / `.TRT` → Canada. `.L` / `.LON` → UK. Bare symbol AND `currency=USD` → USA. Else unknown. |
| Default tax-loss-harvest threshold | Hardcoded `$500 CAD` constant. No household-level setting in v1. |
| Fixed-income detection from free-text `Security.assetType` | Substring match: `assetType?.toLowerCase().match(/bond\|gic\|fixed\|treasury\|note\|debent/) !== null`. |
| Superficial-loss-rule scope | All visible accounts in caller's household (`visibleAccountWhere(req)`). Matches CRA "affiliated persons" treatment. |
| Endpoint strategy | Standalone `GET /api/portfolio/by-account-type`. Not bolted onto existing routes — tab-specific shape, on-demand. |
| Weight % within bucket | Bucket-local: `holding.marketValueCad / bucket.totalCadMV × 100`. NOT unified-CAD (which is slice A's concern). |

## 3. Today's state (recap)

- `AccountTaxStatus` enum already on `Account` model: `registered_tfsa | registered_rrsp | registered_fhsa | registered_rrif | non_registered | n_a`.
- `Security.metadata` JSON column (from slice F) holds `country` field when populated via AV `OVERVIEW` backfill.
- `Security.metadata.exchange` similarly available — used by US-withholding flag.
- Slice F's `security_dividends` table provides per-security dividend history → drives `us_payer_in_tfsa` flag.
- Slice A's `loadMetricsContext` provides batch FX rates for CAD conversion.
- No existing tax-loss-harvest or superficial-loss helpers — slice D introduces both.

## 4. Backend

### 4.1 New endpoint — `GET /api/portfolio/by-account-type`

Authenticated, household-scoped via `visibleAccountWhere(req)` + `accountType: 'investment'`.

```ts
type Response = {
  buckets: PortfolioByAccountTypeBucket[]
  warnings: PortfolioByAccountTypeWarning[]
  harvestCandidates: PortfolioByAccountTypeHarvestCandidate[]
}

type PortfolioByAccountTypeBucket = {
  taxStatus: 'registered_tfsa' | 'registered_rrsp' | 'registered_fhsa' | 'registered_rrif' | 'non_registered' | 'n_a'
  label: string  // TFSA | RRSP | FHSA | RRIF | Non-registered | Other
  accounts: Array<{ id: number; name: string; currency: string }>
  holdingsCount: number
  totalCadMV: number | null  // null when any holding's FX is missing
  allocationByAssetType: Array<{
    assetType: string | null
    marketValueCad: number
    percentage: number  // within bucket
  }>
  rows: Array<{
    securityId: number
    symbol: string
    name: string | null
    assetType: string | null
    accountId: number
    accountName: string
    quantity: number
    currency: string
    marketValue: number          // native currency
    marketValueCad: number | null
    costBasis: number | null     // native currency
    unrealizedGainCad: number | null
    weightInBucketPct: number | null
    flags: Array<'us_withholding' | 'fixed_income_in_non_reg' | 'us_payer_in_tfsa'>
  }>
}

type PortfolioByAccountTypeWarning = {
  kind: 'fixed_income_in_non_reg' | 'us_payer_in_tfsa'
  securityId: number
  symbol: string
  accountName: string
  text: string  // user-facing one-liner
}

type PortfolioByAccountTypeHarvestCandidate = {
  securityId: number
  symbol: string
  accountId: number
  accountName: string
  unrealizedLossCad: number  // positive magnitude
  superficialLossWarning: boolean
  superficialLossDetail: string | null
}
```

### 4.2 Bucket assembly algorithm

1. `accounts = Account.findAll({ where: { ...visibleAccountWhere(req), accountType: 'investment' } })`. Group by `taxStatus`.
2. `latestHoldings = loadVisibleLatestHoldings(req)` — same helper used elsewhere.
3. `metricsCtx = loadMetricsContext({ securityIds, currencies, accountIds })` for FX rates (reuses slice A module).
4. For each `taxStatus` represented in visible accounts:
   - Filter `latestHoldings` to that bucket's accountIds.
   - Compute per-row CAD market value: `marketValue × fxRates.get(currency) ?? null` (CAD passthrough = identity).
   - `bucket.totalCadMV` = sum of per-row CAD MVs. If any row is `null` (FX missing), `totalCadMV = null`.
   - `bucket.allocationByAssetType` = group rows by `assetType` (treat `null` as `'Other'` label), sum `marketValueCad`, compute percentage of bucket.
   - `bucket.rows` = each holding with flags + `weightInBucketPct`.
5. Empty buckets (no holdings AND no accounts) omitted from response. Buckets with accounts but zero holdings still shown (clean "TFSA is empty" state).
6. `warnings` = dedupe + flatten `fixed_income_in_non_reg` and `us_payer_in_tfsa` flags from all rows.
7. `harvestCandidates` = compute per row in `non_registered` accounts (see §4.4).

### 4.3 Helper module — `backend/src/portfolio/tax-buckets.ts`

```ts
import type { AccountTaxStatus } from '../models/Account'
import type { Security } from '../models/Security'
import type { Account } from '../models/Account'

export const TAX_STATUS_LABELS: Record<AccountTaxStatus, string> = {
  registered_tfsa: 'TFSA',
  registered_rrsp: 'RRSP',
  registered_fhsa: 'FHSA',
  registered_rrif: 'RRIF',
  non_registered: 'Non-registered',
  n_a: 'Other',
}

// Tab display order (left-to-right, top-to-bottom).
export const TAX_STATUS_ORDER: AccountTaxStatus[] = [
  'registered_tfsa',
  'registered_rrsp',
  'registered_fhsa',
  'registered_rrif',
  'non_registered',
  'n_a',
]

const CANADIAN_SUFFIXES = ['.TO', '.NEO', '.CSE', '.V', '.TRT']
const UK_SUFFIXES = ['.L', '.LON']

export function isUsDomiciled(security: { symbol: string; currency: string; metadata: Record<string, unknown> | null }): boolean {
  const country = (security.metadata?.['country'] as string | undefined)?.toLowerCase()
  if (country) {
    return country === 'usa' || country === 'united states' || country === 'us'
  }
  const sym = security.symbol.toUpperCase()
  if (CANADIAN_SUFFIXES.some((s) => sym.endsWith(s))) return false
  if (UK_SUFFIXES.some((s) => sym.endsWith(s))) return false
  if (sym.includes('.')) return false  // some other exchange suffix → not USA
  return security.currency === 'USD'
}

export function isFixedIncome(assetType: string | null): boolean {
  if (!assetType) return false
  return /bond|gic|fixed|treasury|note|debent/i.test(assetType)
}

export type RowFlagsInput = {
  security: { symbol: string; currency: string; assetType: string | null; metadata: Record<string, unknown> | null }
  account: { taxStatus: AccountTaxStatus }
  hasDividends: boolean   // caller pre-computes from security_dividends table
}

export type RowFlag = 'us_withholding' | 'fixed_income_in_non_reg' | 'us_payer_in_tfsa'

export function rowFlags(input: RowFlagsInput): RowFlag[] {
  const flags: RowFlag[] = []
  const us = isUsDomiciled(input.security)
  if (us && input.account.taxStatus === 'non_registered') flags.push('us_withholding')
  if (isFixedIncome(input.security.assetType) && input.account.taxStatus === 'non_registered') flags.push('fixed_income_in_non_reg')
  if (us && input.hasDividends && input.account.taxStatus === 'registered_tfsa') flags.push('us_payer_in_tfsa')
  return flags
}
```

### 4.4 Harvest-candidate logic

```ts
export const TAX_LOSS_THRESHOLD_CAD = 500

export type HarvestInput = {
  securityId: number
  symbol: string
  accountId: number
  accountName: string
  costBasisCad: number | null
  marketValueCad: number | null
}

// Returns null if not a candidate (below threshold, no loss, or missing data).
export function harvestCandidate(input: HarvestInput): { unrealizedLossCad: number } | null {
  if (input.costBasisCad == null || input.marketValueCad == null) return null
  const loss = input.costBasisCad - input.marketValueCad
  if (loss <= TAX_LOSS_THRESHOLD_CAD) return null
  return { unrealizedLossCad: loss }
}
```

Superficial check is a separate DB query per candidate (or one batch query for all candidates). Within the route:

```ts
// For each candidate, check ±30d buy activity in any visible account.
const today = new Date()
const windowStart = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10)
const windowEnd = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10)
const recentBuys = await InvestmentActivity.findAll({
  where: {
    accountId: visibleAccountIds,
    securityId: harvestCandidates.map((c) => c.securityId),
    activityType: ['buy', 'reinvestment'],
    tradeDate: { [Op.between]: [windowStart, windowEnd] },
  },
  attributes: ['securityId', 'accountId', 'tradeDate'],
})
// Index by securityId, attach warning + detail to matching candidates.
```

`windowEnd` is in the future (today+30d). At time of analysis, future buys don't yet exist in the DB — they're impossible. The check effectively becomes "buys in the last 30 days". The future window is included for completeness so the helper signature works equally well if/when "what-if" date queries are added.

### 4.5 Backend tests

- `backend/test/portfolio/tax-buckets.test.ts` — unit tests for `isUsDomiciled` (with country / symbol suffix / bare USD / unknown cases), `isFixedIncome` (bond / GIC / mixed case / null), `rowFlags` (combinatorial coverage), `harvestCandidate` (above / at / below threshold, null inputs).
- `backend/test/integration/portfolioByAccountType.test.ts` — end-to-end with seeded TFSA + RRSP + non-reg accounts holding mixed CAD/USD securities. Asserts bucket grouping, flags, warnings, harvest candidates including a superficial-loss-positive case.

## 5. Frontend

### 5.1 Shared type additions (`shared/api-types.ts`)

```ts
export type PortfolioByAccountTypeBucket = { ... }
export type PortfolioByAccountTypeWarning = { ... }
export type PortfolioByAccountTypeHarvestCandidate = { ... }
export type PortfolioByAccountType = {
  buckets: PortfolioByAccountTypeBucket[]
  warnings: PortfolioByAccountTypeWarning[]
  harvestCandidates: PortfolioByAccountTypeHarvestCandidate[]
}
```

(Exact field shapes mirror §4.1.)

### 5.2 New tab

In `frontend/src/pages/PortfolioPage.tsx`:

```ts
const TAB_ITEMS: TabItem[] = [
  { value: 'holdings', label: 'Holdings' },
  { value: 'by-security', label: 'By security' },
  { value: 'allocation', label: 'Allocation' },
  { value: 'by-account-type', label: 'By account type' },  // NEW
  { value: 'income', label: 'Income' },
  { value: 'realized', label: 'Realized P&L' },
]

type TabKey = ... | 'by-account-type'
```

New `<TabPanel value="by-account-type">` renders `<AccountTypePanel />`.

### 5.3 New components

| File | Responsibility |
|---|---|
| `frontend/src/pages/portfolio-account-type/AccountTypePanel.tsx` | Top-level: owns `/api/portfolio/by-account-type` fetch + state |
| `frontend/src/pages/portfolio-account-type/TaxWarningsStrip.tsx` | Renders `warnings[]` as dismissible-looking text rows; omitted when empty |
| `frontend/src/pages/portfolio-account-type/HarvestCandidatesStrip.tsx` | Renders `harvestCandidates[]` with loss amount + superficial-loss annotation |
| `frontend/src/pages/portfolio-account-type/BucketCard.tsx` | Single bucket: label + totals + donut (reuses slice F `<AllocationDonut>`) |
| `frontend/src/pages/portfolio-account-type/BucketBreakdownTable.tsx` | Concatenated all-buckets breakdown table at the bottom |

### 5.4 Layout

```
┌────────────────────────────────────────────────────────────────┐
│ [TaxWarningsStrip] (if any)                                    │
│  ⚠️ Fixed income held in non-reg: BND in TFSA01                │
│  ⚠️ US dividend payer in TFSA: VOO in TFSA01                   │
├────────────────────────────────────────────────────────────────┤
│ [HarvestCandidatesStrip] (if any)                              │
│  💰 BND (Non-reg TFSA01): unrealized loss $612 CAD             │
│     ⚠️ Superficial loss risk: bought 2026-05-10 in RRSP01      │
├────────────────────────────────────────────────────────────────┤
│ [Bucket card grid, 2 cols on lg, 1 col on sm]                  │
│  ┌─────────────────┐ ┌─────────────────┐                       │
│  │ TFSA            │ │ RRSP            │                       │
│  │ $42,300 CAD     │ │ $128,500 CAD    │                       │
│  │ 5 holdings · 1  │ │ 8 holdings · 1  │                       │
│  │ [asset donut]   │ │ [asset donut]   │                       │
│  └─────────────────┘ └─────────────────┘                       │
│  ... non-reg, FHSA, RRIF, Other as applicable                  │
├────────────────────────────────────────────────────────────────┤
│ [BucketBreakdownTable]                                         │
│  Bucket │ Account │ Symbol │ Qty │ MV (CAD) │ Weight │ Flags   │
└────────────────────────────────────────────────────────────────┘
```

### 5.5 Empty states

- Zero investment accounts → "No investment accounts. Add one via the Accounts page."
- Buckets render but contain no holdings → "TFSA is empty. Holdings appear here after import."
- No warnings → strip omitted from DOM
- No harvest candidates → strip omitted from DOM

### 5.6 Frontend tests

- `frontend/src/pages/portfolio-account-type/AccountTypePanel.test.tsx`:
  - Happy path: renders bucket cards + breakdown table for seeded fixture
  - Warnings strip renders + hides when `warnings[]` empty
  - Harvest strip renders superficial annotation when `superficialLossWarning: true`
  - Empty-state when zero accounts
- `frontend/src/pages/portfolio-account-type/BucketCard.test.tsx`:
  - Renders label + totals
  - Donut renders when allocationByAssetType non-empty

## 6. Out of scope

- Allocation drift / `target_weight` (deferred)
- Automated harvest-trade suggestions
- Optimal asset-location math
- Spousal RRSP attribution rules
- Year-end vs intraday tax-loss timing
- Per-household threshold setting (hardcoded $500 instead)
- TFSA contribution-room tracking
- RRSP deduction-room tracking

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | `Account.taxStatus='n_a'` accounts mixed with real investment accounts → confusing "Other" bucket | "Other" label is honest; existing Accounts page lets users update `taxStatus` |
| 2 | Same security in multiple non-reg accounts → harvest list shows multiple rows | Document: each row is per-(account, security). User can sell from one without affecting other. |
| 3 | Superficial-loss check uses ±30d centered on today; missing the historical "if-I-had-sold-X-days-ago" view | Documented behavior — flag means "if you sold this today" |
| 4 | FX missing for one currency → entire bucket `totalCadMV` is null | Per-row `marketValueCad` is null too — UI renders "—". Bucket card shows partial coverage warning. |
| 5 | Tab adds DB load per click | 60s frontend cache (existing pattern from Income/Realized tabs) |
| 6 | Symbol-suffix heuristic over-classifies (e.g. `BRK.A` is US, but `.A` could match generically) | Allowlist of Canadian + UK suffixes is exclusive; everything else without explicit country falls through to USD-currency check. `BRK.A` has currency USD → US ✓. |
| 7 | Substring fixed-income match catches false positives ("BANKNOTE FUND" matches `note`) | Acceptable v1 false-positive rate. Could refine to word-boundary regex if it surfaces in practice. |

## 8. Acceptance criteria

1. `GET /api/portfolio/by-account-type` returns `{ buckets, warnings, harvestCandidates }` scoped to caller's household.
2. Buckets exist for each `taxStatus` represented in caller's investment accounts; empty buckets (no accounts AND no holdings) omitted.
3. Each bucket includes `totalCadMV`, `allocationByAssetType`, `rows[]` with per-row flags.
4. `warnings[]` enumerates `fixed_income_in_non_reg` + `us_payer_in_tfsa` flags as discrete items.
5. `harvestCandidates[]` lists non-registered holdings with `unrealizedLossCad > 500`.
6. `superficialLossWarning: true` when ±30d buy/reinvestment exists in any visible account for the same security.
7. Frontend renders "By account type" tab between Allocation and Income.
8. Tab fetches data on activation; bucket cards + warnings + harvest strips + breakdown table all render per the layout in §5.4.
9. Empty states render correctly (no accounts, no holdings, no warnings, no candidates).
10. All new + existing tests pass; build / typecheck / lint clean.

## 9. Next step

User reviews. Approve → invoke `superpowers:writing-plans` for the file-by-file plan.
