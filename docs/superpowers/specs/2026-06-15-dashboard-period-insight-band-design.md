# Dashboard Period Insight Band — Design

**Date:** 2026-06-15
**Status:** Approved (brainstorm), pending implementation plan
**Primitives touched:** Transaction, Counterparty (no new primitive, no new table)

## Problem

When looking at a period (e.g. "last month"), the dashboard's hero number is a
single opaque figure: `netSpend = totalSpend − totalCredits`. It conflates three
different things — money actually **consumed**, money **loaned out / owed back**
(reimbursable claims and partner splits), and the absence of any "is this normal
for me?" context. The user's framing: *"instead of saying you spent 10k — you
spent 6, loaned 4."*

The loaned/owed-back money is **already tracked** (the `Reimbursement` model and
`Transaction.partnerShareAmount` / partner splits), and balances are already
computed by `/api/reimbursements/summary` and `/api/partner/fairness`. The
dashboard headline simply ignores it. So this is a **surfacing / derivation
problem**, not new capture.

The user selected three wants: (1) honest decomposition of the headline, (2) what
changed and why, (3) better comparisons. All three are derivations over existing
data.

## Goal

Replace the opaque hero number with a range-aware **Period Insight Band** that, for
the selected date range, shows:

1. **Honest decomposition** — `realCost` (true consumption) as the headline, with
   loaned-out and owed-to-you surfaced explicitly.
2. **Smart comparisons** — `realCost` (and a loaned-out trend) vs baselines that
   adapt to the kind of range selected.
3. **What changed** — the top 2–3 category movers with their concrete drivers.

All numbers deterministic (no LLM) — the point is a number the user trusts.

## Non-goals

- No new capture flow for loans — loaned money is already tracked.
- No LLM-generated narrative (rejected: opaque, can be wrong, undermines trust).
- No new primitive or table — this is views/derivations on Transaction +
  Counterparty.

---

## Section 1 — Honest decomposition (the math)

The existing per-currency `netSpend` is split, not replaced. Core identity:

```
netSpend  =  realCost  +  owedBack
```

- **`owedBack`** — money spent in this period that is coming back to the user.
  Summed over transactions **dated in the range**, from two sources:
  - **reimbursable** — `Reimbursement.amount` linked to in-range transactions
  - **partnerShare** — `Transaction.partnerShareAmount` on in-range shared txns
  - `owedBack` is counted **regardless of repayment status** — loaning money is
    not consumption whether or not it has been paid back yet. (Repayment/collection
    status feeds the separate "owed to you overall" stock below, not this figure.)
- **`realCost`** = `netSpend − owedBack` — true consumption. **This is the new big
  headline number.**

**Guards:**
- **No double-count.** A transaction that is both reimbursable *and* partner-split
  contributes its owed portion **once** — dedup by `transactionId`. Precedence:
  the **reimbursable claim amount wins** (explicit claim over implicit split); the
  two are never summed for a single txn. This rule is **total and deterministic
  regardless of the data** — if both never co-occur on one txn it is a harmless
  no-op; if they do, it prevents the double-count. So the "do both ever co-occur?"
  question does **not** gate the design; it is a one-line implementation-time
  confirmation against prod (a `SELECT` for txns having both a `Reimbursement` row
  and a non-null `partnerShareAmount`), not a design open question.
- **Flow vs stock.** `owedBack` is a **flow** (loaned out *this period*). Show one
  separate **stock** figure — **owed to you overall** — total outstanding
  receivable across all time, from `/api/reimbursements/summary` (status ∈
  {expected, overdue}) + `/api/partner/fairness` balance. Optional subline: "of
  this period's loaned-out, $N already collected."

**Headline reads:** `Real spend $6,000` · *loaned out $4,000 this period · $X owed
to you overall*.

---

## Section 2 — Smart comparisons (range-aware)

Today's only comparison is the prior equal span. The band detects the **kind** of
range selected (reusing the calendar-range helpers shipped 2026-06-15:
`getCalendarMonthRange` / quarter / year) and adapts. `rangeKind` ∈
`calendar-month | calendar-quarter | calendar-year | custom`.

Comparisons run on **`realCost`** (not gross) so loaning money never reads as a
spending spike.

**`calendar-month`** — compare `realCost` against three baselines:
- **prior month** ("vs May")
- **same month last year** ("vs Jun 2025" — seasonality)
- **typical month** — rolling 12-month average month ("is this normal for me?")

**`calendar-quarter` / `calendar-year`** — analogous (prior period, same period
last year, typical period).

**`custom`** — fall back to **prior-equal-span** (today's behavior) plus a
**per-day-rate vs typical-day** line, since named baselines do not apply.

**Loaned-out trend** — the same baseline machinery applied to `owedBack`, surfacing
"lending more than usual" when this period's loaned-out runs materially above the
typical baseline.

**Rendering:** compact chips, e.g.
`vs last month −8% · vs typical +12% · vs Jun '25 +5%`.

**Insufficient history → hidden, never faked.** A baseline window with no/partial
data is omitted entirely (no "−100% vs $0").

**"Typical" baseline thresholds (resolved).** `typical` = the simple average of the
**trailing complete periods of the same kind**, excluding the current in-progress
period:
- **calendar-month** → average the trailing **complete calendar months**, require
  **≥ 3**, cap the window at the **trailing 12** ("recent typical"). < 3 complete
  months of history → omit the `typical` chip.
- **calendar-quarter** → trailing complete quarters, require **≥ 2**, cap at **4**.
- **calendar-year** → **no `typical` baseline** (insufficient multi-year history in
  practice); year ranges use prior-period + same-period-last-year only.

`prior-period` and `same-period-last-year` are shown whenever their single window
has data; otherwise omitted by the same hidden-never-faked rule.

---

## Section 3 — What changed (movers)

Reuses `explainMonth.ts`'s category-delta logic (already deterministic),
generalized to the selected range vs the chosen baseline (default: typical;
fall back to prior period when typical is unavailable).

Top 2–3 categories whose **`realCost`** moved most, each with its **driver**:

```
Groceries +32% (+$420) vs typical — 3 Costco trips
Dining    −40% (−$180) vs typical — fewer takeout orders
```

The "why" is the largest contributing merchant(s) + txn count behind the delta —
verifiable and clickable through to `/transactions?category=…`. No LLM.

---

## Section 4 — Build structure

### Backend — one new endpoint

`GET /api/summary/period-insight?currency&dateFrom&dateTo` → `PeriodInsightResp`
(typed in `shared/api-types.ts`). Computes the whole band server-side,
deterministically.

```ts
interface PeriodInsightResp {
  byCurrency: Array<{
    currency: string;
    netSpend: number;
    realCost: number;
    owedBack: number;
    owedBackBreakdown: { reimbursable: number; partnerShare: number };
    collectedThisPeriod?: number;       // optional "of which collected" subline
    receivablesOutstanding: number;     // stock: owed to you right now, all-time
    comparison: {
      rangeKind: 'calendar-month' | 'calendar-quarter' | 'calendar-year' | 'custom';
      baselines: Array<{
        key: 'prior-period' | 'same-period-last-year' | 'typical' | 'per-day-rate';
        realCost: number;
        realCostDeltaPct: number;
        owedBack: number;
        owedBackDeltaPct: number;
      }>;                               // unavailable baselines omitted
    };
    movers: Array<{
      category: string;
      currentRealCost: number;
      baselineRealCost: number;
      deltaAbs: number;
      deltaPct: number;
      driver: { topMerchant: string | null; txnCount: number };
    }>;
  }>;
}
```

Reuses existing building blocks — do not reimplement:
- reimbursements outstanding (logic behind `/api/reimbursements/summary`)
- `partnerFairness` balance computation
- `explainMonth.ts` category-delta helpers
- calendar-range helpers (`getCalendarMonthRange` etc.)
- the existing net-spend classification (`isNonSpend` / `classifyTransactionFlow`,
  `aggregateDashboard` net-spend formula) — `realCost` derives **from** the same
  `netSpend`, it does not redefine spend classification.

Lives under `backend/src/summary/` paired with a `routes/summary.ts` handler;
register the mount in `routeRegistry.ts` (gated, after `requireAuth`).

### Frontend — `<PeriodInsightBand>`

New component at the **top of `DashboardPage`**, range-aware: refetches on currency
/ date-range change (same `dashboard.currency` / `dashboard.dateFrom` /
`dashboard.dateTo` session state the page already uses). Three stacked parts:

1. **Decomposition headline** — `realCost` large; loaned-out + owed-to-you sublines.
2. **Comparison + trend chips** — realCost baselines and the loaned-out trend.
3. **Movers** — 2–3 rows with delta badges + driver text, clickable to
   `/transactions`.

**`HeroTile` is superseded by the band (resolved).** The band becomes the single
period-summary surface and `HeroTile` is retired:
- net-spend headline → replaced by the `realCost` decomposition headline
- its delta badges → replaced by the comparison + trend chips
- its 12-month sparkline → **absorbed into the band, replotted on `realCost`**
  (not gross `netSpend`) so the trendline matches the new headline
- its secondary submetrics (income / credits / payments) → kept, as a compact
  secondary row inside the band

`KpiStack` (txns / merchants / accounts) stays as its own separate tile. The
existing `DeltaBadge` component is reused for chips/movers. Prefer Tailwind
utilities over raw CSS.

### Spine fit

`period-insight` is a **new query/derivation** (Three-checks: extends Transaction
for spend, Counterparty for owed-back; derived, not persistent; mirrors no existing
machine). No new table, no new primitive.

---

## Error handling

- **Insufficient-history baseline** → omitted from `baselines` (never faked zeros).
- **Owed-back overlap** → deduped per `transactionId` (reimbursable wins).
- **Zero-spend period** → graceful empty state (no division-by-zero in deltas;
  delta vs $0 baseline rendered as "new"/"n/a", not a percent).
- **`currency=all`** → resolve per-currency; band renders the primary currency
  headline with a per-currency breakdown (match existing dashboard currency
  behavior).
- **Endpoint failure** → band shows an error/empty state without breaking the rest
  of the dashboard (independent fetch, like the other tiles).

## Testing

**Backend (colocated unit tests, `*.test.ts` beside source):**
- decomposition identity: `realCost + owedBack === netSpend` across fixtures
- owed-back dedup: txn both reimbursable and partner-split counts once
- owed-back ignores repayment status; `receivablesOutstanding` reflects only
  outstanding
- `rangeKind` detection: calendar-month / quarter / year / custom
- baseline windows: prior-period, same-period-last-year, rolling-typical average
- insufficient-history → baseline omitted
- zero-spend and negative-edge fixtures

**Frontend (vitest, colocated):**
- band renders decomposition headline (realCost / loaned / owed-to-you)
- unavailable baselines hidden
- mover rows render with driver text and link targets

---

## Resolved decisions (previously open)

- **"Typical" baseline thresholds** — month: trailing complete months, min 3, cap
  12; quarter: min 2, cap 4; year: no typical. (Section 2.)
- **`HeroTile`** — retired; superseded by the band. Sparkline absorbed and
  replotted on `realCost`; income/credits/payments submetrics kept as a secondary
  row in the band. (Section 4, Frontend.)
- **reimbursable-vs-partnerShare overlap** — precedence rule (reimbursable wins,
  dedup per txn) is total and deterministic, so the data question does not gate the
  design. Implementation-time confirmation only: a prod `SELECT` for txns carrying
  both. (Section 1.)

No remaining open design questions.
