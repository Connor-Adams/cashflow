# Issue #201 — Budgets + monthly pacing

## Current state

PR #31 already shipped a basic budgets feature (table `budget_targets`,
CRUD routes, dashboard widget). The issue is an expansion request:

- Add **pacing comparison** ("Dining is 88% spent but month is only 62%
  complete") — the headline UX.
- Add **scope** column (the issue says personal/partner/business/household,
  Cashflow's existing transaction vocabulary uses visibility=private|shared
  plus finalBusiness flag — see scope-mapping decision below).
- Add **rollover_enabled** flag (schema only, behavior is a follow-up).
- Extend **period** values from `monthly` to `monthly | weekly | annual`.
- Add `budget_exclusions` join table.
- Surface a `GET /budgets/status` endpoint (the issue's wording) — implement
  as an alias of `/progress` with new fields (pacing pct, scope filter).

## Scope mapping decision

The issue lists 4 scopes: `personal | partner | business | household`.
Cashflow's existing transaction model expresses these orthogonally:

- `visibility` (private | shared)
- `ownershipType` (me | partner | other)
- `finalBusiness` (boolean)

Mapping budget.scope → transaction filter (when computing spend):

- `personal` → visibility = private AND finalBusiness = false (user's own
  private personal spend)
- `partner` → visibility = private AND ownershipType = partner (partner's
  private spend that user can see if they're partner)
- `business` → finalBusiness = true (any business spend)
- `household` → visibility = shared (shared/joint spend)

`scope` defaults to `household` (most inclusive — matches current
behavior). Existing budgets stay on `household` after migration.

## Data model changes

### Migration A: extend `budget_targets`

```js
add_column budget_targets.scope        VARCHAR(16) NOT NULL DEFAULT 'household'
add_column budget_targets.rollover_enabled BOOLEAN NOT NULL DEFAULT false
// `period` stays VARCHAR(16) — already extensible (no enum); just expand
// allowlist in routes/validators.
add_index  budget_targets (household_id, scope, currency, category)
```

Down: drop the two columns + the new index.

### Migration B: create `budget_exclusions`

```js
create_table budget_exclusions {
  id              SERIAL PK
  budget_id       INT NOT NULL REFERENCES budget_targets(id) ON DELETE CASCADE
  transaction_id  INT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE
  created_at      TIMESTAMP NOT NULL
  updated_at      TIMESTAMP NOT NULL
  UNIQUE (budget_id, transaction_id)
}
add_index (budget_id)
add_index (transaction_id)
```

Down: drop table.

## Routes

- `POST /api/budgets` — add `scope` (validated), `rolloverEnabled` (boolean),
  `period` (allow weekly/annual).
- `PUT /api/budgets/:id` — same fields patchable.
- `GET /api/budgets/status` — NEW endpoint (issue spec). Returns
  `BudgetStatus[]` with: budgetId, category, currency, scope, target, spent,
  remaining, percentUsed, **monthElapsedPercent**, **pacingState**
  ('on-pace' | 'ahead' | 'behind' | 'over'), periodStart, periodEnd,
  rolloverEnabled. Internally reuses computeBudgetProgress + new
  computeMonthPacing pure helper.
- `GET /api/budgets/progress` — keep existing for back-compat (dashboard
  widget still calls it), but extend its response with the same new fields
  (additive — no breaking changes).
- `POST /api/budgets/:id/exclusions` — body `{ transactionId }`, idempotent.
- `DELETE /api/budgets/:id/exclusions/:transactionId` — remove exclusion.
- `GET /api/budgets/:id/exclusions` — list exclusions for one budget.

Spend aggregation must:
- Exclude transactions whose id is in `budget_exclusions` for that budget.
- Filter by `scope` (using the mapping above).
- Honor existing per-period bounds for monthly; add weekly/annual support
  (computeWeekBounds / computeYearBounds pure helpers).

## Pacing math (the headline)

```ts
function monthElapsedPercent(now: Date, bounds: { periodStart, periodEnd }): number {
  // (days_elapsed + day_fraction) / total_days_in_period * 100
  // Reason: at noon on day 5 of a 30-day month, we're 14.5% through, not 13.3%.
  const startMs = Date.parse(bounds.periodStart + 'T00:00:00');
  const endMs = Date.parse(bounds.periodEnd + 'T23:59:59.999');
  const nowMs = now.getTime();
  if (nowMs <= startMs) return 0;
  if (nowMs >= endMs) return 100;
  return ((nowMs - startMs) / (endMs - startMs)) * 100;
}

function pacingState(percentUsed, monthElapsed): 'on-pace' | 'ahead' | 'behind' | 'over' {
  if (percentUsed > 100) return 'over';
  // "Ahead" of budget = spending faster than time elapsed (yellow).
  // "Behind" = spending slower than time elapsed (green-ish, frugal).
  // "On pace" within ±5 percentage points.
  const delta = percentUsed - monthElapsed;
  if (delta > 5) return 'ahead';
  if (delta < -5) return 'behind';
  return 'on-pace';
}
```

Pacing applies to monthly and annual periods. For weekly, compute
weekElapsedPercent the same way over 7 days.

## Frontend

- Extend `BudgetsTab` settings with scope dropdown + period select.
- Add `BudgetExclusionsTab` (admin-style minimal: list-and-add exclusions
  per budget) — polished UX is a follow-up issue.
- Dashboard `budgetPill` adds a small pacing badge ("on pace" / "ahead" /
  "behind" / "over") and a thin secondary tick on the bar at the
  monthElapsed% mark so the comparison is visible at a glance.
- Update `Budget`, `BudgetInput`, `BudgetProgress` types.

## Tests (acceptance criteria → test mapping)

- [x] Add `budgets` table → migration test (round-trip new columns and
      exclusions table)
- [x] Add budget CRUD API → existing tests pass; new tests cover scope,
      period values, rolloverEnabled
- [x] Add budget status API → new integration test for `/status` returns
      pacing fields
- [x] Show category progress → existing dashboard widget tests pass,
      extended with pacing badge
- [x] Compare spend percentage against month elapsed percentage → unit
      tests for monthElapsedPercent + pacingState
- [x] Support personal/shared/business scope → integration test seeding
      each scope, verifying scope filter on spend aggregation
- [x] Support excluded transactions → integration test creating exclusion,
      verifying spend doesn't count the excluded txn

## Out of scope (follow-up issues)

- Rollover BEHAVIOR (carry unused budget across months). Schema flag only
  for now; UI shows the toggle but it has no effect server-side.
- Polished exclusion management UI (icon in transaction row,
  bulk-exclude, etc.).
- Weekly/annual dashboard tiles (this PR's dashboard widget remains
  monthly-scoped to avoid bloat).
