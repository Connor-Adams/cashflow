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
  contributes its owed portion **once** — dedup by `transactionId`. Resolution
  rule when both exist on one txn: take the reimbursable claim amount (explicit
  claim wins over implicit split); document the chosen txn IDs path in tests.
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
data is omitted entirely (no "−100% vs $0"). Define a minimum-coverage threshold
for "typical" (e.g. require ≥ N months of history; finalize N in the plan).

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

The current `HeroTile` sparkline folds into the band or sits beside it; the
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

## Open items for the plan

- Finalize minimum-history threshold N for the "typical" baseline.
- Decide whether `HeroTile` sparkline is absorbed into the band or kept adjacent.
- Confirm the reimbursable-vs-partnerShare precedence rule against real data
  fixtures (whether any txn legitimately carries both).
