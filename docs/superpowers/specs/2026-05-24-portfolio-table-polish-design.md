# Slice E — Logo + Sparkline Polish on Portfolio Tables

**Status:** Design spec. Second slice from the [Portfolio Enrichment Umbrella](./2026-05-24-portfolio-enrichment-vision.md).
**Date:** 2026-05-24
**Scope:** Single PR. Adds `<SecurityLogo>` to four tables and a 30-day `<Sparkline>` column to two of them. Backed by a new batch endpoint that returns sparkline data for every visible security in one call.

---

## 1. Goal

Give every row in every portfolio table a face. Holders no longer need to recognize tickers by string — they see the issuer's logo and the recent price trend in line.

## 2. Decisions locked from the brainstorm

| Question | Decision |
|---|---|
| Sparkline data fetch | New batch endpoint `GET /api/portfolio/sparklines?range=30d` — single round-trip, parallel to existing portfolio fetches. |
| Backfill-on-table-load behavior | None. Sparklines endpoint is pure read. Securities without `security_daily_prices` rows render a blank cell. Users seed history by visiting the detail page (existing F lazy backfill). |
| Sparkline range | `30d` hardcoded in v1. Query param accepted (for future-proofing) but only `30d` honored. |
| Letter-avatar palette | Reuse F's curated 12-color hash palette in `letter-avatar.tsx`. No changes. |
| Sparkline scope | Only on Holdings + By-security tables (per umbrella). Income / Realized tables get logo only. |
| Logo size | `sm` (24px) across all four tables. Matches `<SecurityLogo size="sm">`. |

## 3. Today's state (recap)

- Slice F shipped (PR #146, merged): backend tables `security_daily_prices` + `security_dividends` + `securities.metadata`; frontend primitives `<SecurityLogo>`, `<LetterAvatar>`, `<Sparkline>`, `<MetricStat>`; lazy backfill module.
- PR #147 added a quote scheduler (4-min cron) that fills `SecurityPrice` (append-only quote log) via `GLOBAL_QUOTE`. Distinct from `security_daily_prices`. **Coordination caveat:** PR #147's `ProviderJobLog` budget and F's in-process `RateBudget` are two separate consumers of the same 25/day AV quota with no coordination. Out of scope for this slice; flagged for a follow-up.
- Portfolio tables today have plain-text symbol cells, no sparklines, no logos.

## 4. Backend

### New endpoint — `GET /api/portfolio/sparklines?range=30d`

Authenticated, household-scoped, reuses `visibleAccountWhere` + `currentAuth(req)`.

```ts
type Response = {
  range: '30d';
  bySecurityId: {
    [securityId: number]: Array<{
      date: string;   // 'YYYY-MM-DD'
      close: number;  // adj_close, numeric
    }>;
  };
};
```

**Algorithm:**

1. Resolve caller's visible investment accounts via `visibleAccountWhere(req)` + `accountType: 'investment'`.
2. Collect distinct `securityId` set from `InvestmentActivity` and `HoldingSnapshot` where `accountId IN visibleAccountIds`.
3. For each such security, query last 30 days of `security_daily_prices` ordered ASC by date.
4. Omit securities with zero rows from the response map. Smaller payload + clearer "no data" signal.
5. Numeric `close` from `adj_close` column (matches detail-page chart convention).

**Range param:** accept `?range=30d` (default), reject anything else with 400. Future ranges land via additive constants.

### Tests

`backend/test/integration/portfolioSparklines.test.ts`:

| Case | Assertion |
|---|---|
| No holdings | `bySecurityId == {}` |
| Security with 30+ daily prices | Returns up to 30 rows oldest→newest |
| Security with fewer than 30 days | Returns what's there |
| Security with zero daily prices | Omitted from response map |
| Security in another household | Not in response (household scoping) |
| `range=7d` (invalid) | 400 |

Reuse existing `portfolioFixtures.ts` helpers (`seedDailyPrice` already exists from F task 13).

## 5. Frontend

### Type addition

`shared/api-types.ts` — append:

```ts
export type PortfolioSparklinePoint = { date: string; close: number };

export type PortfolioSparklines = {
  range: '30d';
  bySecurityId: Record<number, PortfolioSparklinePoint[]>;
};
```

### `PortfolioPage` changes

**Parallel fetch in `load()`:**

```tsx
const [summaryRes, allocRes, bySecRes, sparkRes] = await Promise.all([
  getJson<PortfolioSummary>('/api/portfolio'),
  getJson<PortfolioAllocation>('/api/portfolio/allocation'),
  getJson<PortfolioBySecurity>('/api/portfolio/by-security'),
  getJson<PortfolioSparklines>('/api/portfolio/sparklines?range=30d'),
])
setSparklines(new Map(Object.entries(sparkRes.bySecurityId).map(([k, v]) => [Number(k), v])))
```

New page state: `const [sparklines, setSparklines] = useState<Map<number, PortfolioSparklinePoint[]>>(new Map())`.

Pass `sparklines` down to `HoldingsPanel` and `BySecurityPanel`. (Income and Realized panels don't need sparkline data, but the page also passes them nothing new — they only get logos via `<SymbolLink>`.)

### `HoldingsPanel` changes

- Symbol cell — prepend logo:

```tsx
<TableCell>
  <span className="flex items-center gap-2">
    {holding.security && (
      <SecurityLogo size="sm" symbol={holding.security.symbol} name={holding.security.name} />
    )}
    {holding.security ? (
      <Link to={`/portfolio/security/${holding.security.id}`} ...>{holding.security.symbol}</Link>
    ) : '—'}
  </span>
</TableCell>
```

- New table column **30d** added between **Unrealized** and **As of**:

```tsx
<TableHead>30d</TableHead>
...
<TableCell>
  {holding.security && (
    <Sparkline data={(sparklines.get(holding.security.id) ?? []).map(p => ({ date: p.date, value: p.close }))} />
  )}
</TableCell>
```

`<Sparkline>` returns `null` for fewer than 2 points, so empty cell renders blank naturally.

### `BySecurityPanel` changes

Same logo + sparkline pattern. Column inserted between **Accounts** and **Latest quote**.

### `<SymbolLink>` change (used by Income + Realized by-security tables)

Extend signature to accept `name`:

```tsx
function SymbolLink({ securityId, symbol, name }: { securityId: number | null; symbol: string | null; name?: string | null }) {
  if (securityId == null || !symbol) return <>{symbol ?? '—'}</>
  return (
    <span className="flex items-center gap-2">
      <SecurityLogo size="sm" symbol={symbol} name={name} />
      <Link to={`/portfolio/security/${securityId}`} ...>{symbol}</Link>
    </span>
  )
}
```

`IncomeBySecurityRow` and `RealizedBySecurityTable` callers pass `name={row.name ?? undefined}`. Existing render call sites stay backward compatible (name is optional).

### Frontend tests

Extend `frontend/src/pages/PortfolioPage.test.tsx` (or create if missing):

- Holdings table renders `<img>` (logo) for a security
- Holdings table renders an svg sparkline for a security with data
- Holdings table renders blank sparkline cell for security with no daily-price data
- By-security table renders logo + sparkline column
- Income by-security table renders logo

## 6. Out of scope

- Sparkline range selector (1w/3m/1y) — defer
- Sparkline on Income / Realized tables — umbrella scope
- "Today Δ%" / "30d Δ%" columns — slice A
- Backfill trigger from sparklines endpoint — explicit no
- Reconciling F's `RateBudget` and PR #147's `ProviderJobLog` budget — separate follow-up

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | First-install user has no `security_daily_prices` data → all sparklines blank → looks broken | Acceptable: clean degradation. User seeds via detail page visits (existing F flow). Could add an empty-state hint in a future polish PR. |
| 2 | Existing `PortfolioPage.test.tsx` may need updates for new column count | Update tests as part of the slice |
| 3 | Logo + sparkline added bytes per row → table renders wider | Tables already horizontally scroll on narrow widths. No new behavior. |
| 4 | `<SecurityLogo>` async image load → layout jank | Logo has fixed width/height via `size` prop. No reflow. |
| 5 | Sparklines payload size on accounts with 100+ securities | 100 × 30 × ~30 bytes = ~90KB JSON. Fine. Compression brings well under. |

## 8. Acceptance criteria

1. `GET /api/portfolio/sparklines?range=30d` returns shape `{ range: '30d', bySecurityId: {...} }` scoped to caller's household.
2. Securities without `security_daily_prices` rows omitted from response.
3. Holdings tab Symbol cell shows logo (or letter-avatar fallback) prepended to symbol text.
4. Holdings tab has a `30d` column with sparkline (green if up, red if down) when data exists; blank when not.
5. By-security tab Symbol cell shows logo; new `30d` column behaves same as Holdings.
6. Income by-security and Realized by-security tables show logo prepended to symbol cell (no sparkline).
7. Page makes one round-trip for sparkline data, in parallel with existing `/api/portfolio` fetches.
8. No new AV API calls triggered by visiting any portfolio tab.
9. Existing PortfolioPage behaviors (refresh quotes, totals row, tabs, drill links) unchanged.
10. All new + existing tests pass.

## 9. Next step

User reviews this spec. After approval → invoke `superpowers:writing-plans` to produce the file-by-file plan.
