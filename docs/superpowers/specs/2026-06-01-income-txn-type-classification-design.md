# Income classification for the enrichment pipeline

**Date:** 2026-06-01
**Primitive:** Transaction (variant field `txn_type`). New *behavior* on an
existing classifier — not a new primitive, no new table.

## Problem

The detect-type stage (`backend/src/import/enrichment/detectTypeStage.ts`) had
no `income` branch. Two failure modes in prod (household 1):

- Payroll **"Direct deposit from CDG LABS INC"** matched the broad `transfer`
  regex (which literally contains `direct deposit`) → tagged `transfer`.
- Other positive inflows with no narrative cue fell to `unknown`.

Result: **zero** `txn_type='income'` rows despite recurring paychecks; ~$149k of
positive inflow sat in `unknown` (mostly Wealthsimple investment contributions —
a separate issue) and real payroll was buried in `transfer`.

Downstream was already income-ready: `classifyTransactionFlow.NON_SPEND_TXN_TYPES`
includes `income`, `classifyPositiveAmount` maps `income → 'credit'`, and
`aggregateSankey` routes it to the Income node. Only the **detector** was missing.

## The hard part: income vs internal transfer

Real income arrives on the same rail as internal money movement. In prod the
entire income universe is three `"Direct deposit from <X>"` streams, all pure
inflows (no opposite-sign sibling):

| merchant_raw (truncated at 35 chars) | account | verdict |
|---|---|---|
| `Direct deposit from CDG LABS INC` | 24 Corporate Chequing | income |
| `Direct deposit from ADAMS GREENE HO` | 14 Chequing | income (holdco/employer) |
| `Direct deposit from ADAMS CONNOR DO` | 14 Chequing | **transfer** — owner's own name |

Bank descriptions are **truncated to 35 chars**, so a corporate-entity suffix
(`INC`/`LTD`/`HOLDINGS`) is not reliably present — `ADAMS GREENE HO` and
`ADAMS CONNOR DO` are both marker-less name strings. The only thing separating
them is that `ADAMS CONNOR` is a household member's own name (a self-deposit).

## Decision: own-name exclusion

A positive row classifies as `income` when:

1. it matches `payroll | salary | paycheque | paycheck`, **or**
2. it matches `direct deposit from`, **and** the payee is neither
   - an own-account word (`chequing|checking|savings|tfsa|fhsa|rrsp|rrif|rdsp|margin|crypto`), nor
   - a **household member's full name** — every token of some member's display
     name (e.g. `{connor, adams}`) appears in the payee.

The member-name test is a **token superset** match (not substring), so a shared
surname alone (`ADAMS` in both `Connor Adams` and external `ADAMS GREENE`) does
**not** misclassify external income as a self transfer.

The check runs in `runDetectTypeStage` after the bare-`deposit` exact match and
**before** the `PATTERNS` loop (so it wins over `transfer`); it is safe at that
position because income narratives don't collide with the higher-precedence
`refund`/`payment`/`dividend`/`investment`/`fee`/`reward` patterns. Negative
amounts never classify as income (a payroll reversal is not income).

### Alternatives rejected

- **Corporate-marker regex** — infeasible: truncation removes the suffix from
  `ADAMS GREENE HO`.
- **Account designation** (mark acct 24 as an income account) — robust for the
  dedicated corporate-chequing case, but acct 14 mixes employer income and
  self-deposits, so it can't disambiguate there.
- **Employer allowlist** — precise but manual; doesn't generalize to new payers.
- **Entity-type signal** — no `entities` table exists; `entity_id` is a
  dangling/legacy column and is NULL on the canonical CDG rows.

## Implementation

- `types.ts`: add `'income'` to the `TxnType` union (DB column is free-text
  `STRING(16)`, default `purchase` — no enum migration).
- `detectTypeStage.ts`: `detectsIncome()` + the income branch; new optional
  `ownerNames?: string[]` on `DetectTypeInput`.
- `enrich.ts`: thread `ownerNames` from `EnrichInputs` into the detect-type call.
- `loaders.ts`: `loadHouseholdOwnerNames(householdId)` — household members'
  `User.displayName`s.
- Wired into all three `enrichTransaction` callers: `runImport`,
  `commitStatementImport`, and `runEnrichmentBackfill` (per-household memoized).

## Backfill

No new script. `runBackfill` (`runEnrichmentBackfill.ts`) re-runs the full
pipeline, is idempotent, never touches `*_override`/`reviewed_at`, and is already
reachable via the transactions route, the scheduler, and the coordinator. Once
`ownerNames` is threaded it promotes existing rows to `income` automatically.

**Predicted prod impact (household 1):** 23 rows → `income`
(`CDG LABS INC` ×2 + `ADAMS GREENE` ×21, ≈ $64,125); `ADAMS CONNOR` self-deposit
(×2, $7,954) stays `transfer`. Run dry (`dryRun: true`) first and diff before the
real run.

## Out of scope

The ~$149k of positive `unknown` rows are Wealthsimple investment-account
movement (`Contribution`, `Money transfer into the account`, `Deposit`) — a
different machine (internal money movement), not income. Not addressed here.
