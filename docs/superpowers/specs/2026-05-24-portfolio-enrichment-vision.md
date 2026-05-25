# Portfolio Enrichment — Umbrella Vision

**Status:** Vision doc (umbrella). Per-slice specs follow.
**Date:** 2026-05-24
**Scope:** Coordinating design for six independent enrichment slices of the cashflow portfolio view. Each slice ships as its own design doc + plan + PR.

---

## 1. Goal

Turn the portfolio view from a numbers grid into a tactile, exploratory surface:

- Every holding has a **face**: logo + sparkline in tables.
- Every holding has a **story**: enriched detail page with price chart, dividend history, sector, and per-account drill.
- The portfolio has **forward context**: projected income, yield-on-cost, allocation drift, tax-bucket view, performance vs benchmark.

## 2. Non-goals

- Real-time / streaming quotes. (Free tier cannot support; refresh-on-demand only.)
- Order entry / trading. (This is a reporting app.)
- Per-holding custom benchmarks. (Single global benchmark, configurable per household.)
- Replacing existing tabs. (All work is additive.)

## 3. Today's state (recap)

- 5 tabs: Holdings, By security, Allocation, Income, Realized P&L.
- Per-security drill at `/portfolio/security/:id` (ACB timeline + activities + snapshots).
- Backend routes: `/api/portfolio` family (7 routes) backed by `Security`, `SecurityPrice`, `InvestmentActivity`, `HoldingSnapshot`, `Account`.
- `SecurityPrice` is append-only — de-facto thin time series of every refresh, NOT true daily history.
- `Account.taxStatus` already labelled (`registered_rrsp` / `registered_tfsa` / `registered_fhsa` / `registered_rrif` / `non_registered` / `n_a`).
- Quote provider: Alpha Vantage `GLOBAL_QUOTE`. Free tier: 25 calls/day, 5/min.
- No sector, no logo, no dividend schedule, no historical daily prices today.

## 4. Data sourcing decisions

Approach: free tier today, paid-required parts called out explicitly per slice.

| Need | Free path | Paid alternative |
|---|---|---|
| Latest quotes | AV `GLOBAL_QUOTE` (already wired) | Polygon, AV Premium, FMP |
| Historical daily prices | AV `TIME_SERIES_DAILY_ADJUSTED` via nightly backfill worker | Any paid provider — clean intraday + bulk fetch |
| Sector / industry / country / exchange | AV `OVERVIEW`, cached, refreshed quarterly | FMP / Polygon profile endpoints |
| Dividend schedule | AV `DIVIDENDS` (historical events; cadence inferred forward) | Polygon `dividends` forward calendar |
| Logos | Curated `tickerToDomain.ts` map (top Cdn ETFs + actual holdings) + `logo.clearbit.com/{domain}` + letter-avatar fallback | logo.dev (~$9/mo, global) or brandfetch |
| Benchmark | Just another `Security` row (default `XEQT.TO`), backfilled by the same worker | Same — no upgrade needed |

### Free-tier rate budget

- 25 calls/day. Reserve 5/day for ad-hoc refreshes; spend 20/day on backfill.
- Backfill worker priorities: (1) newly added securities — full 20yr history, (2) existing securities — daily delta only.
- Pessimistic: first-time onboarding of N securities takes `ceil(N/20)` days. Accept this; show "history loading" banner on detail page.

## 5. Shared primitives

Built incidentally during Slice F. Reused by every later slice. **Slice F's spec must explicitly list these as deliverables alongside the detail page itself.**

| Primitive | What | Location |
|---|---|---|
| `securityLogo(symbol, name)` | Returns logo URL via curated map + Clearbit; fallback letter-avatar with stable color per first letter | `frontend/src/lib/securityLogo.ts` |
| `<SecurityLogo size>` | `img` with on-error fallback to `<LetterAvatar>` | `frontend/src/components/ui/security-logo.tsx` |
| `<Sparkline data range>` | Tiny recharts line, no axes, green/red by direction | `frontend/src/components/ui/sparkline.tsx` |
| `<MetricStat label value delta deltaPct>` | StatCard variant with delta + colored arrow | `frontend/src/components/ui/metric-stat.tsx` |
| `GET /api/portfolio/security/:id/prices?range=` | Daily price array for chart + sparkline | `backend/src/routes/portfolio.ts` |
| `GET /api/portfolio/security/:id/dividends` | Historical + inferred-forward dividend events | `backend/src/routes/portfolio.ts` |
| `GET /api/portfolio/security/:id/overview` | Cached AV `OVERVIEW` fields (sector, industry, country, description) | `backend/src/routes/portfolio.ts` |
| Daily-price backfill worker | Nightly cron: hits `TIME_SERIES_DAILY_ADJUSTED` for securities with no rows in `security_daily_prices` (full backfill, 20yr) or with last-row date older than yesterday (delta), respects rate budget | `backend/src/portfolio/priceBackfill.ts` |
| `Security.metadata` JSON column | Caches `OVERVIEW` (sector, industry, country, exchange, description) | New migration |
| `security_daily_prices` table | True daily history (separate from append-only `SecurityPrice` snapshot table) | New migration |
| `security_dividends` table | Per-security ex-div events | New migration |

## 6. Sequencing

```
F (detail page)
    ├─► E (table polish)
    │       └─► A (more metrics)
    │
    ├─► D (tax-bucket tab)        [parallelizable after primitives]
    │
    └─► B (performance over time)
            └─► C (forward-looking)
```

**Rationale:** F first because all primitives land there. E & A inherit them and progressively enrich tables. D is independent UI work over existing `taxStatus` data + sector from `OVERVIEW` cache. B is the largest backend lift (daily snapshots + return math). C reuses B's daily snapshot infra + the dividend table built incidentally by F.

## 7. Slice summaries

Each slice has its own detailed spec (forthcoming). What follows is intent + scope only.

### F — Enriched per-holding detail page

`/portfolio/security/:id` becomes the rich landing page for any clicked holding.

**In scope (free):**
- Header: large `<SecurityLogo>`, name + symbol, badges (asset type, currency, exchange, sector via `OVERVIEW`).
- Stat row: qty, MV, cost basis, unrealized, realized to date, lifetime income, **today change %**, **30-day return %**, **yield-on-cost**.
- **Price chart** (line, default 1Y, range toggle 1M/3M/1Y/5Y/All) via `/security/:id/prices`. Buy/sell markers overlaid.
- **Dividend history chart** (bar per ex-div date) via `/security/:id/dividends`.
- Per-account ACB cards (retained).
- Activity timeline + holdings snapshots (retained).
- "About" panel: sector, industry, country, description (`OVERVIEW`, truncated).

**Paid-required (called out, not built):** news headlines, analyst targets, ESG scores, intraday chart.

**New endpoints:** `/security/:id/prices`, `/security/:id/dividends`, `/security/:id/overview`.

**Open questions for F's spec:**
- Range toggle: client-side filter on a full payload, or server `range=` query param?
- Buy/sell overlay style: dots, colored vertical lines, or annotation markers?

### E — Logo + sparkline polish on tables

Every row in every portfolio table gets a face.

**In scope (free):**
- `<SecurityLogo size="sm">` prepended to Symbol cell on Holdings, By security, Income by-security, Realized by-security tables.
- 30-day `<Sparkline>` column on Holdings + By-security (green if up, red if down).
- Letter-avatar fallback: stable color per first letter (so `BNS` stays consistent across views).

**Out of scope:** Per-row "today change %" badge (deferred to A).

**Open questions for E's spec:**
- Sparkline range = 30d default; configurable?
- Letter-avatar palette: hash-to-Tailwind-tone or curated?

### A — More metrics on existing tabs

Tables stop being a balance sheet; become a dashboard.

**In scope (free):**

| Tab | New columns / stats |
|---|---|
| Holdings | **Today Δ%**, **30d Δ%**, **Weight %** (of unified CAD total), **Yield (TTM)** |
| By security | **Today Δ%**, **30d Δ%**, **Total return %** (`(currentMV + realizedToDate + lifetimeIncome − costBasis) / costBasis`, since first buy), **Weight %** |
| Allocation | **Drift Δ** vs target weights (if household sets targets — new optional `securities.target_weight`) |
| Top-stats row | "Today" delta stat card next to Total (CAD) |

**Paid-required:** beta, alpha, Sharpe (need risk-free rate + benchmark covariance).

**New backend:** `priceAtDaysAgo(securityId, n)` helper using `security_daily_prices`; `totalReturn` aggregate added to by-security response; optional `target_weight` migration on `securities`.

**Open questions for A's spec:**
- Weight % per-currency or unified CAD?
- Target weights stored per-security or per-asset-type bucket?

### D — Tax / account-type tab

Group holdings by `Account.taxStatus` to answer "what's in my TFSA vs RRSP vs non-reg?" and flag tax-relevant issues.

**In scope (free):**
- New tab **"By account type"** between Allocation and Income.
- Bucket cards: TFSA / RRSP / FHSA / RRIF / Non-reg / N/A. Each: total MV, holdings count, allocation donut by asset type within the bucket.
- Breakdown table: bucket → security → qty + MV + weight within bucket.
- **US-withholding flag:** heuristic (`currency=USD` && exchange not in `TSX|NEO|CSE`).
- **Asset-location warnings:** flag fixed-income held in non-reg; flag US dividend payers held in TFSA. Text only, non-blocking.
- **Tax-loss harvest candidates:** non-reg holdings with unrealized loss > threshold (default $500), with superficial-loss-rule warning if same security bought in any account ±30 days.

**Paid-required:** automated harvest-trade suggestions, optimal asset-location math.

**New backend:** `GET /api/portfolio/by-account-type`; tax-rule helpers reuse Phase-3-tax logic where possible.

**Open questions for D's spec:**
- "US-domiciled" source: `OVERVIEW.Country` field. Fallback if missing?
- Default harvest threshold: per-household setting or global $500?

### B — Performance over time tab

Portfolio value time series + return metrics + benchmark compare.

**In scope (free):**
- New tab **"Performance"**.
- **Portfolio value chart:** stacked area, daily granularity (after backfill), range toggle 1M/3M/1Y/All.
- **TWR (time-weighted return):** computed from daily snapshots + cash-flow adjustments (deposits/withdrawals; reinvested dividends counted as internal).
- **MWR / IRR:** XIRR over all cashflows + current MV.
- **Benchmark overlay:** configurable benchmark security (default `XEQT.TO`), normalized to portfolio start value.
- Stat row: TWR (1M / YTD / 1Y / All), MWR, vs-benchmark Δ%.

**Paid-required:** sub-daily resolution, per-security TWR attribution.

**Backend lift (largest in umbrella):**
- New `portfolio_daily_snapshots` table (chosen over recompute-on-the-fly for read speed; storage cost is negligible).
- TWR/IRR math (`backend/src/portfolio/returns.ts`).
- Daily snapshot builder (nightly cron).
- Reuse backfill worker — benchmark security is just another `Security` row.

**Open questions for B's spec:**
- Snapshot retention policy: forever, or aged out after N years?
- TWR convention: reinvested dividends = internal flow (default) or external?

### C — Forward-looking tab

"How much income should I expect, and when?"

**In scope (free):**
- New tab **"Forward income"**.
- **Projected annual dividend income:** per holding = `qty × inferred_annual_dividend`. Cadence inferred from AV `DIVIDENDS` history (sum last 4 quarters, or `dividend × frequency`).
- **Yield (forward):** projected annual income / current MV.
- **Upcoming ex-div calendar:** 90-day forward look using last cadence. Dates flagged as estimates.
- **Income by currency × bucket** breakdown.
- Totals: projected next-12-month income; CAD-converted total.

**Caveat panel:** projections assume cadence holds; cuts/raises not predicted. Flag securities whose last 4 dividends are inconsistent.

**Paid-required:** earnings forecasts, analyst estimates.

**New backend:** `GET /api/portfolio/forward-income`; `inferDividendCadence(events)` helper; AV `DIVIDENDS` integration in backfill worker (already built for F).

**Open questions for C's spec:**
- Bonds + GIC interest: include now or punt to v2?
- Mid-year position changes: project off as-of-today qty or weighted-average qty?

## 8. Cross-cutting open questions

These affect more than one slice; resolve in the umbrella, not per-slice spec.

1. **Backfill worker scheduling:** nightly cron at what hour? Project has no existing cron infra — needs a decision on `node-cron` vs a dedicated worker process.
2. **`security_daily_prices` schema:** `(security_id, date, open, high, low, close, adj_close, volume)` — index on `(security_id, date)`. Confirm adj_close is what the chart uses (splits/dividends-adjusted).
3. **Logo legal/TOS:** Clearbit's free logo endpoint is technically deprecated. Acceptable to depend on it through Slice E ship? Fallback letter-avatar covers gaps cleanly.
4. **Benchmark default:** `XEQT.TO` reasonable Cdn default? Configurable from where — Settings page, or per-portfolio?
5. **"household" scope of all new endpoints:** confirmed; reuse existing `currentAuth(req).household` + `visibleAccountWhere`.

## 9. Out of umbrella scope (explicit)

- Mobile-specific portfolio view.
- Push notifications on price moves / ex-div approaching.
- CSV / PDF export of any new view.
- Multi-currency benchmark (use single CAD-normalized).
- Tax-optimized rebalancing recommendations.

## 10. Next steps

1. User reviews + approves this umbrella vision doc.
2. Slice F gets its own detailed design spec → plan → PR.
3. As each subsequent slice is picked up, it gets the same treatment.
4. Update this umbrella when slice scopes shift materially.
