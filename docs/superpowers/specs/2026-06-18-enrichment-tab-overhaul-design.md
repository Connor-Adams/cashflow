# Enrichment Tab Overhaul — Design

**Date:** 2026-06-18
**Status:** Approved (pending spec review)
**Supersedes:** PR #116 enrichment tab redesign (extends, does not replace its components)

## Problem

The enrichment tab (`frontend/src/pages/settings/tabs/EnrichmentTab.tsx`, landed
in PR #116) is a read-only, all-time-cumulative dashboard with one all-or-nothing
action (backfill). Three concrete gaps:

1. **Dead-end dashboard.** The confidence/source/txn-type buckets and the top
   canonical merchants are not clickable — a user sees "312 AI-low-confidence
   transactions" but cannot jump to them. Only "Needs review" links anywhere.
2. **No insight into the actual problems.** Every number is lifetime cumulative.
   There is no surfacing of the work to do (uncategorized backlog, merchants with
   no canonical, rules that never fire) and no sense of trajectory.
3. **Wasted data + orphaned chrome.** `byTxnType` is fetched by the stats
   endpoint and never rendered. The "Refresh" button floats mid-page; the backfill
   card floats at the bottom.

This overhaul delivers all three requested directions — **actionability**,
**better insight**, and **visual polish** — in one tab.

## Scope

A+B+C, shipped as one coherent tab. Three sections are new (Needs attention,
Coverage trend, clickable Breakdown); the rest is restructure of existing
components.

## Primitives check

- New `/enrichment/coverage` endpoint is a **query/derivation over the
  Transaction primitive** — no new table, no new status machine, no spine change.
- New stats fields (`uncategorizedCount`, `merchantsMissingCanonical`,
  `deadRules`) are **derived aggregates** over existing `transactions` / `rules`
  columns. No persistent state added.
- Confirmed: this is a feature/view change, not a spine change.

## Key constraint — no enrichment-event timestamp

The `transactions` table has **no `enriched_at` column**. Available timestamps:
`date` (DATEONLY, the spend date), `createdAt` (import time), `reviewedAt`,
`updatedAt`. Enrichment runs at import and again on backfill, so neither
`createdAt` nor `reviewedAt` is a faithful "when enrichment happened" signal.

Therefore the coverage trend is defined as **coverage by spend date**: bucket
transactions by `date`, report what fraction are review-cleared and what fraction
have a canonical merchant. This answers the real question — *"is recent spend
better enriched than old spend?"* — without inventing an enrichment-event
timeline. The chart label states the axis is spend date.

(`transaction_signals.created_at` exists and could power a true
enrichment-activity timeline in a future iteration; out of scope here.)

## Backend

### 1. Extend `buildTransactionFilterWhere` (`backend/src/routes/transactions.ts:127`)

Add four enum filters so the list endpoint can be deep-linked from the tab:

| query param        | column              |
|--------------------|---------------------|
| `autoSource`       | `auto_source`       |
| `autoConfidence`   | `auto_confidence`   |
| `txnType`          | `txn_type`          |
| `merchantCanonical`| `merchant_canonical`|

Each accepts a `(none)` sentinel meaning `IS NULL` (the stats buckets use
`(none)` as the key for null values, so the link round-trips). String values are
matched exactly. ~20 lines, no schema change.

### 2. Extend `GET /enrichment/stats`

Add to the `EnrichmentStats` DTO and the handler (`transactions.ts:1911`):

- `uncategorizedCount: number` — `COUNT(*) WHERE final_category IS NULL`
- `merchantsMissingCanonical: number` — `COUNT(*) WHERE merchant_canonical IS NULL`
- `deadRules: Array<{ ruleId: number; pattern: string; category: string | null }>`
  — household rules that have fired zero times:
  ```sql
  SELECT r.id, r.merchant_pattern, r.category
  FROM rules r
  WHERE r.household_id = ?            -- or all, for superadmin
    AND r.id NOT IN (
      SELECT applied_rule_id FROM transactions
      WHERE applied_rule_id IS NOT NULL
    )
  LIMIT 15
  ```

All three queries join the existing `Promise.all` batch in the handler.

### 3. New `GET /enrichment/coverage?bucket=month`

Coverage-by-spend-date timeseries. Default `bucket=month`, also accepts `week`.
Default window: last 12 buckets.

```
Response: {
  bucket: 'month' | 'week',
  series: Array<{ period: string; total: number; cleared: number; withCanonical: number }>
}
```

`cleared` = `NOT review_flag`; `withCanonical` = `merchant_canonical IS NOT NULL`.
Grouping truncates `date` to the bucket. **Dual-dialect**: SQLite uses
`strftime('%Y-%m', date)` (and `%Y-%W` for week); Postgres uses
`to_char(date, 'YYYY-MM')` (and `IYYY-IW` for week). Branch on the active dialect,
matching the existing dual-dialect pattern in the codebase. Household-scoped like
the stats endpoint (superadmin sees all).

## Frontend

### Restructure `EnrichmentTab.tsx` into four stacked sections

**Section 1 — Needs attention (new, top).** A worklist row of clickable
`StatCard`s: `Needs review`, `Uncategorized`, `Missing canonical`, `Dead rules`.
Each links to the relevant filtered view:

- Needs review → `/review` (unchanged) or `/transactions?reviewFlag=true`
- Uncategorized → `/transactions?category=(none)` (uses the new null sentinel)
- Missing canonical → `/transactions?merchantCanonical=(none)`
- Dead rules → `/rules`

Reuses the existing warning-tile styling from `EnrichmentStatRow`. The existing
`EnrichmentStatRow` (Total / Cleared / Recurring / Refunds / Transfers) stays,
either folded into or beneath this section.

**Section 2 — Coverage trend (new).** `EnrichmentCoverageChart` — a recharts
area/line of `% cleared` and `% with canonical` over the spend-date buckets, with a
month/week toggle. Fetches `/enrichment/coverage`. Axis labeled "spend date".

**Section 3 — Breakdown.** The existing `EnrichmentConfidenceChart` and
`EnrichmentSourceChart`, now **clickable** (each bar → filtered `/transactions`),
**plus** a third chart rendering the previously-unused `byTxnType`. Three-column
grid that collapses to one on narrow viewports.

**Section 4 — Top lists.** Existing `EnrichmentTopLists`; add per-row links to the
top canonical merchants (rules already link), and add a small dead-rules list
under the top-rules card.

**Chrome consolidation.** The orphaned "Refresh stats" button and the
`EnrichmentBackfillCard` trigger move into a coherent header / action area rather
than floating.

### Clickable contract

One helper:

```ts
function enrichmentFilterHref(param: string, value: string): string
// value '(none)' → param set to the null sentinel the backend understands
// otherwise → /transactions?<param>=<encoded value>
```

Bars, stat cards, and merchant rows render as `<Link>`s built from this helper.
`TransactionsPage` reads the four new params inside its existing `useSearchParams`
block (`frontend/src/pages/TransactionsPage.tsx:261`) and threads them into the
list request.

## Error / empty handling

Each new aggregate degrades independently — a failing coverage fetch must not
blank the stat row. Sections render their own empty states reusing the existing
`muted` copy. An empty dead-rules list means a healthy ruleset and renders
nothing.

## Testing

**Backend**
- `buildTransactionFilterWhere`: unit tests for each of the 4 new params incl. the
  `(none)` → `IS NULL` path.
- `/enrichment/stats`: assert the 3 new fields; dead-rules query returns only
  zero-fire household rules.
- `/enrichment/coverage`: SQLite unit test on bucketing + a dual-dialect guard so
  the Postgres `to_char` branch is exercised in integration.

**Frontend**
- Colocated test per new/changed component (`EnrichmentCoverageChart`, the
  needs-attention worklist, clickable breakdown bars, the `byTxnType` chart).
- Assert generated link hrefs (including null-sentinel encoding).
- Empty states.
- Reuse the PR #116 test patterns already in
  `frontend/src/pages/settings/tabs/enrichment/`.

## Out of scope

- True enrichment-activity timeline from `transaction_signals` (future).
- Inline rule editing / merchant override from the tab (future actionability).
- Per-account coverage breakdown.
