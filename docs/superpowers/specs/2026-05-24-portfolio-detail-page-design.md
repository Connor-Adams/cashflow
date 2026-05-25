# Slice F — Enriched Per-Holding Detail Page

**Status:** Design spec. First slice from the [Portfolio Enrichment Umbrella](./2026-05-24-portfolio-enrichment-vision.md).
**Date:** 2026-05-24
**Scope:** Single mega-PR replacing `/portfolio/security/:id` and shipping all shared primitives (logo, sparkline, metric stat, daily-price + dividend + overview backend + lazy backfill).

---

## 1. Goal

Turn the per-security detail page from "ACB ledger + activity log" into the rich landing page for any clicked holding: logo, multi-range price chart with buy/sell markers, dividend history, company overview, plus the existing per-account ACB / activity / snapshot data retained beneath.

## 2. Decisions locked from the brainstorm

| Question | Decision |
|---|---|
| PR shape | Single mega-PR for all of slice F |
| Backfill scheduler | Lazy + user-triggered (no cron; on detail-page visit, kicks off background backfill) |
| Price chart range toggle | Server-side `?range=1m\|3m\|1y\|5y\|all` query param |
| Buy/sell overlay style | Colored dots on the price line (green=buy, red=sell, sized by qty) |
| "30-day return %" formula | Total return (`((price_today + dividends_in_30d_per_unit) − price_30d_ago) / price_30d_ago`) |
| AV key absent | Graceful per-panel degradation (page still renders) |
| `security_daily_prices` schema | Full OHLCV |
| Dividend chart granularity | One bar per ex-div event |
| Yield-on-cost formula | TTM dividends × current qty / current cost basis |
| Logo source | logo.dev free tier (publishable token via `/api/config`), letter-avatar fallback |

## 3. UI structure

### Page layout

```
┌───────────────────────────────────────────────────────────────────┐
│ ← Back to portfolio                                               │
│                                                                   │
│ [LOGO 64]  XEQT.TO — iShares Core Equity ETF Portfolio            │
│            [ETF] [CAD] [TSX] [Diversified Equity]                 │
│            Combined across accounts + per-account ACB & timeline. │
├───────────────────────────────────────────────────────────────────┤
│ Stat row (8 cards, wraps on narrow widths):                       │
│  Qty │ MV │ Cost basis │ Unrealized                               │
│  Today Δ% │ 30d return │ Yield-on-cost (TTM) │ Realized to date   │
├───────────────────────────────────────────────────────────────────┤
│ [Price chart card]                                                │
│  Range toggle: 1M | 3M | 1Y | 5Y | All    (active=1Y default)     │
│  Line chart of adj_close. Green/red dots overlay buys/sells.      │
│  Empty-state if no data: "History loading…" banner + retry button.│
├───────────────────────────────────────────────────────────────────┤
│ [Dividend history card]                                           │
│  Bar chart, one bar per ex-div event. X=ex-div date.              │
│  Hover: amount + record date + payment date.                      │
│  Empty: "No dividend history" or "Loading…" depending on state.   │
├───────────────────────────────────────────────────────────────────┤
│ [About card]                                                      │
│  Sector / Industry / Country / Exchange table.                    │
│  Description paragraph (truncated, "Show more" expander).         │
│  Source line: "Data from Alpha Vantage · refreshed YYYY-MM-DD".   │
├───────────────────────────────────────────────────────────────────┤
│ Per-account cards (existing, retained)                            │
│ Activity timeline (existing, retained)                            │
│ Historical holdings snapshots (existing, retained)                │
└───────────────────────────────────────────────────────────────────┘
```

### Component map

| Component | Props (essential) | Notes |
|---|---|---|
| `<PortfolioSecurityPage>` | `:id` route param | Top-level; orchestrates fetches |
| `<SecurityHeader>` | `security, overview` | Replaces current `<PageHeader>` block with logo |
| `<SecurityLogo size>` | `symbol, name?` | `<img>` with on-error `<LetterAvatar>` |
| `<LetterAvatar>` | `text, size` | Stable color from `hash(text)`; used as fallback |
| `<MetricStat>` | `label, value, delta?, deltaPct?, hint?, loading?` | StatCard variant with delta arrow |
| `<PriceChartCard>` | `securityId, currency, activities` | Owns range toggle + fetch + buy/sell overlay |
| `<DividendHistoryCard>` | `securityId, currency` | Owns fetch; recharts bar chart |
| `<AboutCard>` | `overview` | Sector / industry / country / exchange + description |

### Stat row formulas

| Stat | Formula | Null behavior |
|---|---|---|
| Qty | `combined.currentQuantity` | — |
| MV | `combined.currentMarketValue` | — |
| Cost basis | `combined.currentCostBasis` | — |
| Unrealized | `MV − cost basis` | — |
| Today Δ% | `(currentPrice − prevClose) / prevClose`. Both from AV `GLOBAL_QUOTE` (already cached in `SecurityPrice`; prevClose is the "previous close" field in the AV response — needs a small storage extension or re-fetch). | "—" if either side missing |
| 30d return | `((price_today + dividends_in_30d_per_unit) − price_30d_ago) / price_30d_ago` | "—" if `coverageDays < 30` |
| Yield-on-cost (TTM) | `sum_dividends_per_unit_last_365d × current_qty / current_cost_basis` | "—" if `current_cost_basis == 0` OR zero TTM dividends |
| Realized to date | `combined.realizedTotal` | — |

### Loading / empty / error matrix

| Condition | Behavior |
|---|---|
| `ALPHA_VANTAGE_API_KEY` not configured | Stat row: Today Δ%, 30d return, Yield-on-cost → "—". Price + Div + About cards show config-prompt placeholder. ACB / activities / snapshots unaffected. |
| Daily prices not yet backfilled | Price chart card shows "History loading… (auto-fetches in background)" + spinner + manual retry button. Frontend polls `/prices` every 5s up to 24 attempts. |
| No dividend history | Div card shows "No dividends recorded for this security." |
| Overview never fetched | About card shows "Loading sector info…", triggers backfill on mount. |
| API error | Per-card error message; page still renders other cards. |
| Daily rate budget exhausted | Banner: "Daily AV quota exhausted — retry after midnight UTC". |

## 4. Backend

### New table — `security_daily_prices`

```
id              SERIAL PK
security_id     INT NOT NULL FK securities(id) ON DELETE CASCADE
date            DATE NOT NULL
open            DECIMAL(20,8)
high            DECIMAL(20,8)
low             DECIMAL(20,8)
close           DECIMAL(20,8) NOT NULL
adj_close       DECIMAL(20,8) NOT NULL
volume          BIGINT
source          VARCHAR(32) NOT NULL DEFAULT 'alpha_vantage'
fetched_at      TIMESTAMP NOT NULL DEFAULT now()
created_at, updated_at
UNIQUE (security_id, date)
INDEX (security_id, date DESC)
```

Distinct from existing `SecurityPrice` table (append-only quote-refresh log). Names kept apart to avoid migration churn on existing rows.

### New table — `security_dividends`

```
id              SERIAL PK
security_id     INT NOT NULL FK securities(id) ON DELETE CASCADE
ex_dividend_date  DATE NOT NULL
declaration_date  DATE NULL
record_date       DATE NULL
payment_date      DATE NULL
amount          DECIMAL(20,8) NOT NULL
currency        VARCHAR(3) NOT NULL
source          VARCHAR(32) NOT NULL DEFAULT 'alpha_vantage'
fetched_at      TIMESTAMP NOT NULL DEFAULT now()
created_at, updated_at
UNIQUE (security_id, ex_dividend_date)
INDEX (security_id, ex_dividend_date DESC)
```

### Column add — `securities.metadata`

```
metadata             JSON NULL    -- caches full AV OVERVIEW payload
metadata_fetched_at  TIMESTAMP NULL
```

Surfaced fields: `sector`, `industry`, `country`, `exchange`, `description`. Other fields kept raw for later slices.

### New endpoints

All under existing `/api/portfolio/` router, scoped to `currentAuth(req).household` and the household's visible accounts. Endpoint handler MUST verify the `:id` security belongs to the caller's household before responding (404 otherwise).

#### `GET /api/portfolio/security/:id/prices?range=1m|3m|1y|5y|all`

```ts
type Response = {
  securityId: number;
  symbol: string;
  currency: string;
  range: '1m' | '3m' | '1y' | '5y' | 'all';
  rows: Array<{
    date: string;        // 'YYYY-MM-DD'
    open: number | null;
    high: number | null;
    low: number | null;
    close: number;
    adjClose: number;
    volume: number | null;
  }>;
  trades: Array<{
    date: string;
    type: 'buy' | 'sell';
    quantity: number;
    price: number | null;
    accountName: string;
  }>;
  backfill: {
    status: 'fresh' | 'stale' | 'never' | 'in_progress' | 'rate_limited';
    lastFetchedAt: string | null;
    nextRetryAt: string | null;
    coverageDays: number;
  };
};
```

- Default range = `1y` if omitted.
- Server slices via `WHERE date >= now() - interval`.
- Zero rows → respond empty `rows`, set `backfill.status='never'`, enqueue backfill.
- `trades` derived from `InvestmentActivity` filtered to `activityType IN ('buy','sell')` for accounts the user can see, AND filtered to the same date window as `rows` (no point overlaying a buy outside the visible chart range).

#### `GET /api/portfolio/security/:id/dividends`

```ts
type Response = {
  securityId: number;
  currency: string;
  events: Array<{
    exDividendDate: string;
    paymentDate: string | null;
    recordDate: string | null;
    amount: number;
    currency: string;
  }>;
  backfill: { /* same shape as prices */ };
};
```

#### `GET /api/portfolio/security/:id/overview`

```ts
type Response = {
  securityId: number;
  sector: string | null;
  industry: string | null;
  country: string | null;
  exchange: string | null;
  description: string | null;
  metadataFetchedAt: string | null;
  backfill: { /* same shape */ };
};
```

#### `GET /api/config` (new — or extends existing)

```ts
type Response = {
  logoDevToken: string | null;
  quoteProviderConfigured: boolean;
};
```

Frontend fetches once at mount, stores on `window.__APP_CONFIG__`. logo.dev token is publishable by design.

### Lazy backfill orchestration

Single module: `backend/src/portfolio/backfill.ts`.

```ts
// Key = `${endpoint}:${securityId}` so concurrent prices + dividends
// for the same security don't dedupe each other.
const inFlight = new Map<string, Promise<void>>();
const rateBudget = new RateBudget({ dailyCap: 20 });   // resets at UTC midnight

export async function ensureDailyPrices(securityId: number): Promise<BackfillStatus>;
export async function ensureDividends(securityId: number): Promise<BackfillStatus>;
export async function ensureOverview(securityId: number): Promise<BackfillStatus>;
```

Algorithm per `ensureX`:

1. Read freshness anchor: latest row `fetched_at` from the target table (or `metadata_fetched_at` for overview).
2. **Never fetched** (zero rows / null metadata) → status `never`, enqueue full fetch.
3. **Stale** (prices: latest `date` older than yesterday; overview: `metadata_fetched_at` older than 90d) → status `stale`, enqueue delta fetch.
4. **Fresh** → no fetch.
5. **Enqueue:** if entry exists in `inFlight`, return `in_progress`. Otherwise store the promise and return immediately.
6. **Promise body:** check rate budget; if exceeded → status `rate_limited`, set `nextRetryAt = next UTC midnight`. Else: call AV, upsert rows, decrement budget, resolve.
7. **On success:** drop from `inFlight`.
8. **On error:** log, drop from `inFlight`, leave `backfill.status='stale'` for the next request.

Polling contract: frontend polls every 5s for up to 24 attempts (~2 min). Typical backfill <5s.

### AV API surface

| Endpoint | Used for | Cost per call |
|---|---|---|
| `TIME_SERIES_DAILY_ADJUSTED` (`outputsize=full`) | First-time backfill of `security_daily_prices` | 1 (returns 20yr) |
| `TIME_SERIES_DAILY_ADJUSTED` (`outputsize=compact`) | Daily delta | 1 (returns last 100 days) |
| `DIVIDENDS` | `security_dividends` | 1 (full history) |
| `OVERVIEW` | `securities.metadata` | 1 |
| `GLOBAL_QUOTE` | Existing — used by `/prices/refresh` | 1 |

One security's full enrichment = 4 calls. At 20/day budget, full first-time enrichment of 5 securities/day maximum.

## 5. Shared primitives (delivered by F, reused by E/A/B/C/D)

### `frontend/src/lib/securityLogo.ts`

```ts
export function securityLogoUrl(symbol: string): string | null {
  const token = window.__APP_CONFIG__?.logoDevToken;
  if (!token) return null;
  const base = symbol.split('.')[0].toUpperCase();
  return `https://img.logo.dev/ticker/${encodeURIComponent(base)}?token=${token}`;
}
```

### `frontend/src/components/ui/security-logo.tsx`

```ts
type SecurityLogoSize = 'sm' | 'md' | 'lg' | 'xl';
type Props = { symbol: string; name?: string | null; size?: SecurityLogoSize };
```

Sizes: `sm=24px`, `md=32px`, `lg=48px`, `xl=64px`. Rounded square, 1px border, white bg. Falls back to `<LetterAvatar>` on img error or missing URL.

### `frontend/src/components/ui/letter-avatar.tsx`

```ts
type Props = { text: string; size?: SecurityLogoSize };
```

First non-whitespace character uppercased. Background color from `hash(text) % palette.length`. Palette aligned to `--chart-line-*` tokens (10–12 colors). Foreground white or near-black via luminance check.

### `frontend/src/components/ui/sparkline.tsx`

```ts
type Point = { date: string; value: number };
type Props = { data: Point[]; width?: number; height?: number };
```

recharts `<LineChart>` with no axes, no grid, no tooltip. Stroke `var(--accent-positive)` if `last >= first` else `var(--accent-warm)`. Default 80×24. Returns `null` if `data.length < 2`.

### `frontend/src/components/ui/metric-stat.tsx`

```ts
type Props = {
  label: string;
  value: string;
  delta?: number;
  deltaPct?: number;
  hint?: string;
  loading?: boolean;
};
```

Existing `<StatCard>` layout plus a delta row: `↑ +1.23%` (green), `↓ −1.23%` (red), or `—`. Loading state renders a skeleton block.

### `tickerToDomain.ts`

Not built in F — logo.dev handles ticker lookup directly. Document as deferred. If we ever switch providers, the map lands in `frontend/src/lib/tickerToDomain.ts`.

## 6. Env vars

```
LOGO_DEV_TOKEN=<publishable token from logo.dev free tier>
```

`ALPHA_VANTAGE_API_KEY` already exists. No other new env vars.

## 7. Testing

### Backend integration tests

- `backend/test/integration/portfolioSecurityPrices.test.ts` — range filter, backfill state shape, empty case, household scoping, `trades` array contents
- `backend/test/integration/portfolioSecurityDividends.test.ts` — events response shape, empty case
- `backend/test/integration/portfolioSecurityOverview.test.ts` — metadata cache hit / miss, raw payload retention
- `backend/test/integration/portfolioBackfill.test.ts` — rate budget exhaustion, dedupe of concurrent backfill, `never → in_progress → fresh` transitions, `stale → fresh` delta, `rate_limited → nextRetryAt`. Mock AV HTTP layer.
- `backend/test/integration/configRoute.test.ts` — `/api/config` returns `logoDevToken` and `quoteProviderConfigured`, never returns `ALPHA_VANTAGE_API_KEY`

### Frontend component tests

- `frontend/src/components/ui/security-logo.test.tsx` — renders img with src; fallback on error; respects size
- `frontend/src/components/ui/letter-avatar.test.tsx` — stable color across renders; readable contrast
- `frontend/src/components/ui/sparkline.test.tsx` — green stroke on uptrend; red on downtrend; null on <2 points
- `frontend/src/components/ui/metric-stat.test.tsx` — delta sign + color; loading skeleton; null delta renders "—"
- `frontend/src/pages/PortfolioSecurityPage.test.tsx` — happy path renders all cards; graceful degradation when AV key absent; "history loading" banner state; range toggle refetches with new query

## 8. Out of scope (deferred to other slices)

- Sparklines on Holdings / By-security tables (slice E)
- "Today Δ%" / "30d Δ%" / "Weight %" columns on tables (slice A)
- News headlines, analyst targets (paid only — flagged in umbrella)
- Intraday / minute resolution (paid only)
- Backfill cron (lazy is the chosen approach for F)
- Per-account TWR/IRR (slice B)
- Forward dividend cadence (slice C)

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | AV `OVERVIEW` schema differs across asset types (ETF / stock / ADR) | Store raw payload in `metadata` JSON; surface only fields present. Cards degrade gracefully on null. |
| 2 | logo.dev free tier could add stricter limits later | Letter-avatar fallback already covers; switching providers is a one-file change in `securityLogo.ts` |
| 3 | AV `DIVIDENDS` reliability for thinly-traded TSX names unknown | Empty event list is valid; UI shows "No dividend history" rather than erroring |
| 4 | In-process rate budget over-spends if multiple server processes ever run | Single-process assumption flagged in code comment. Later: DB-backed budget if needed. |
| 5 | Backfill takes 4 calls per security (price + dividends + overview + delta) | First-visit UX may show loading ~20s; polling at 5s catches them as they land |
| 6 | Symbol mismatch between local DB and AV (`XEQT.TO` vs `XEQT`) | Existing `fetchAlphaVantageQuote` already passes `XEQT.TO`; AV accepts it. No new handling required. |
| 7 | Frontend bundles old build, `window.__APP_CONFIG__` shape drifts | `/api/config` returns extensible object; missing fields default `null` client-side |

## 10. Acceptance criteria

1. Visiting `/portfolio/security/:id` for a held security renders the new layout with all eight stat cards (where data exists).
2. Visiting a security with no daily prices kicks off backfill and shows the "History loading…" banner; banner disappears after backfill completes; chart renders.
3. Range toggle changes the chart and refetches with `range=` query param.
4. Buy/sell markers appear on the price chart at correct dates with correct color.
5. Dividend chart renders one bar per ex-div event.
6. About card shows sector / industry / country / exchange from cached `OVERVIEW`.
7. With `ALPHA_VANTAGE_API_KEY` unset: page renders, AV-dependent cards show config prompts, ACB / activities / snapshots unaffected.
8. With `LOGO_DEV_TOKEN` unset: all logos render as letter-avatars.
9. Hitting `/prices` for a security with 0 rows enqueues backfill once; subsequent hits while in-flight return `status='in_progress'` (no duplicate fetch).
10. Daily rate budget exhausted: backfill returns `status='rate_limited'`, frontend banner says "Daily AV quota exhausted — retry after midnight UTC".
11. Existing security drill behaviors (per-account ACB cards, activity timeline, holdings snapshots) unchanged.
12. All new integration + component tests pass; existing portfolio tests still pass.

## 11. Open items left for the implementation plan

- File-by-file decomposition (migration → models → backfill module → routes → frontend lib → components → page rewrite → tests).
- Test fixtures for AV HTTP mock — reuse / extend existing portfolio fixtures.
- Specific recharts vs. existing chart conventions to match.

## 12. Next step

User reviews this spec. After approval → invoke `superpowers:writing-plans` to produce the file-by-file implementation plan.
