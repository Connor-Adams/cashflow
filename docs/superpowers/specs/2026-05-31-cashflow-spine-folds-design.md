# Cashflow Spine Folds — Expectation merge + Proposal-apply unify

**Date:** 2026-05-31
**Status:** Draft (pending review)
**Type:** Refactor / spine convergence
**Reference:** `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`

## Why

Connor wants to "focus" cashflow by ripping out redundancy — same concept built
N ways. Investigation against live code (not memory) collapsed an initial
six-cluster premise down to the genuine remainder:

- **Already shipped** — review-queue read-fold (`#378`, `/api/review-items`),
  ExternalOrder→Document (`source` field), tax-scenario route fold (`#377`;
  `tax-personal-scenarios.ts` / `tax-corp-scenarios.ts` no longer exist, only the
  folded `/api/tax/scenarios` is mounted).
- **Must not fold** — DebtPayoffScenario / FinancialScenario / HouseholdPlan are
  *distinct* primitives (different status machines; HouseholdPlan `hasMany(Scenario)`
  is a container). Folding would violate "don't merge different-machine objects."
- **Review-queue table merge** — rejected. The read-fold already delivers the one
  cross-source inbox; a physical 5→1 merge would explode JSON `actionItems[]` into
  rows, collapse 6/4/3-state machines, and break every write path for zero net gain.

What genuinely remains is two folds:

1. **Expectation** — `PlannedEvent` + `Subscription` → one table + `kind`
   discriminator. A real prod migration. This is the prize.
2. **Proposal-apply** — the two transaction-apply code paths (`ChatProposal`,
   `AiSuggestion`) share one core helper. Code dedup, no schema change.

Both are named in the spine doc's convergence path
(`primitives-design.md:163`, `:78`, `:85-91`).

## Scope

**In scope:** the two folds above.

**Explicitly out of scope** (verified done or doctrine-violating — do not touch):
tax-scenario routes (`#377` done), ExternalOrder→Document (done), review-queue
*table* merge (rejected), Scenario "forks" (distinct primitives).

---

## Part A — Expectation merge

### Target

One primitive **Expectation** = *expected money movement*, folding `PlannedEvent`
(one-shot) and `Subscription` (recurring) discriminated by a `kind` field. Per
spine doc `:70`, `:93-97`.

**Approach: fold the model/table only — keep every route and page.** The handlers
for `/planned-events`, `/subscriptions`, `/recurring`, `/money-leaks`, `/calendar`
keep their URLs and UIs; they read `Expectation` filtered by `kind`. This preserves
every feature (the stated constraint) and minimizes blast radius — recurrence-aware
consumers that already speak `recurrenceRule` pick up subscriptions for free.

### Status machine (spine amendment)

The Expectation machine gains a fifth state, `cancelled`:

```
planned → posted → skipped / ignored / cancelled
```

- `planned` — expected (one-shot upcoming, or a standing recurring expectation).
- `posted` — a one-shot expectation that occurred (links a Transaction).
- `skipped` — a one-shot expectation that didn't occur.
- `ignored` — user dismissed tracking.
- `cancelled` — user ended the underlying service (distinct from `ignored`:
  provenance is a deliberate cancellation).

**This amends the adopted spine.** The plan must update
`primitives-design.md:70` to `planned → posted → skipped / ignored / cancelled`
and note the addition; also reconcile the convergence-path note (`:163`,
"add cadence") with the `recurrence_rule`-canonical decision below. Flagged as a
spine change, not silent.

Source-status reconciliation on migration:

| Source row | status | → Expectation status | notes |
|---|---|---|---|
| PlannedEvent | planned | planned | |
| PlannedEvent | posted | posted | one-shot only |
| PlannedEvent | skipped | skipped | |
| PlannedEvent | ignored | ignored | |
| Subscription | active | planned | standing recurring = "expected" |
| Subscription | cancelled | cancelled | distinct terminal |
| Subscription | ignored | ignored | |
| Subscription | unknown | planned | + `statusUncertain = true` |

`posted` / `skipped` apply only to one-shot rows; recurring rows are standing
(individual occurrences are derived, not persisted), so they live in
`planned` until `ignored`/`cancelled`.

### Schema

`expectations` = current `planned_events` columns (unchanged) plus:

| New column | Type | Purpose |
|---|---|---|
| `kind` | STRING(16) NOT NULL default `'planned'` | discriminator `'planned' \| 'subscription'` |
| `normalized_name` | STRING(255) null | subscription identity (detection) |
| `annualized_cost` | DECIMAL(14,4) null | subscription rollup |
| `price_change_detected` | BOOLEAN not-null default false | subscription alert |
| `cancellation_url` | TEXT null | subscription |
| `category` | STRING(128) null | subscription category |
| `status_uncertain` | BOOLEAN not-null default false | carries Subscription `unknown` |

Existing-column reuse for subscription data (no new column needed):

| Subscription field | → Expectation column |
|---|---|
| `merchantName` | `name` |
| `cadence` (monthly/weekly) | `recurrence_rule` (RRULE `FREQ=MONTHLY\|WEEKLY`) |
| `nextExpectedDate` | `expected_date` (nullable) |
| `amount`, `currency`, `notes`, timestamps | same-named columns |

**Recurrence representation decision:** `recurrence_rule` (RRULE) is the *single*
canonical recurrence field. Subscription `cadence` converts to an RRULE on
migration; `cadence` is **not** stored — the subscriptions UI/detection derive it
from `FREQ`. Rationale: the 14 PlannedEvent consumers (`forecast`, `calendar`,
`safeToSpend`, `expandRecurrence`, `briefingBuilder`, `reviewRunner`) already
expand `recurrence_rule`; giving subscriptions an RRULE includes them with zero
per-consumer change. Storing a parallel `cadence` would force every expander to
handle two recurrence shapes. (Trade-off is reversible at review.)

Column relaxations / defaults for `kind='subscription'` rows:

- `user_id` → nullable (subscriptions are household-scoped, no user). Relaxing
  NOT NULL is a safe migration.
- `type` → `'expense'`; `source` → `'recurring_detection'` (already a valid
  `PlannedEventSource` value); `account_id`, `linked_transaction_id` → null.
- `expected_date` → nullable (subscriptions may lack a known next charge date;
  `nextExpectedDate` is already nullable). Confirm no reader assumes non-null.

Index: add partial unique index `(household_id, normalized_name, currency) WHERE
kind = 'subscription'` (preserves the current `subscriptions` uniqueness without
constraining planned rows). Confirm partial-index support on the target engine
(Postgres prod; sqlite dev both support `WHERE` indexes via Sequelize `where`).

### MoneyLeak / dismissals

- **No `MoneyLeak` table** — leak rows stay derived views (`money_leaks/detect.ts`
  recomputes on read). Correct per spine `:95`.
- **`money_leak_dismissals` stays its own table.** 3 of 5 leak types
  (`recurring_fee`, `duplicate_service`, `delivery_fee_high`) dismiss a *derived
  pattern* with no Expectation row to flag — it is Observation-shaped, not an
  Expectation field. Do not fold it.

### Migration (prod-safe; additive, reversible until final drop)

1. `rename planned_events → expectations`. Add the new columns above; backfill
   `kind = 'planned'`. Relax `user_id` to nullable.
2. Insert `subscriptions` rows into `expectations` as `kind = 'subscription'`
   with the field mapping + status reconciliation above (`cadence`→RRULE,
   `merchantName`→`name`, etc.). Add the partial unique index.
3. Cut over writers to `Expectation`:
   - `refreshDetectedSubscriptions` (`routes/subscriptions.ts` — sole subscription
     writer) writes `kind='subscription'` Expectation rows.
   - `routes/debt.ts` (`source:'debt'`), `routes/creditCards.ts`
     (`source:'credit_card'`), `routes/plannedEvents.ts` CRUD → `Expectation`.
4. Point all readers at `Expectation` (filtered by `kind` where the old code was
   subscription-specific). Verify row counts + spot-parity per household.
5. **Drop `subscriptions`** only after parity verification. This is the
   irreversible step.

Reversibility: steps 1–4 are additive; the old `subscriptions` table is untouched
until step 5, so a rollback before drop is a writer/reader revert.

### Blast radius

14 backend files touch `PlannedEvent`, 9 touch `Subscription` (3 type-only),
12 frontend files. **Zero incoming FKs** to either table (only Sequelize
associations; `PlannedEvent.linked_transaction_id` points outward to
`transactions`) — nothing cascades on rename/drop. **Re-verify the no-FK claim
immediately before step 5.**

Key touch-points:
- Backend model: `models/PlannedEvent.ts`, `models/Subscription.ts`,
  associations in `models/index.ts:502-535` (PlannedEvent: Household/User/Account/
  Transaction) and `:564-570` (Subscription: Household only).
- Backend readers: `routes/{plannedEvents,calendar,subscriptions,moneyLeaks,
  reports,financialScenarios,forecast,debt,creditCards}.ts`,
  `cashflow/safeToSpend.ts`, `cfo/briefingBuilder.ts`, `ai/reviewRunner.ts`,
  `summary/{dataQuality,explainMonth}.ts`, `forecast/expandRecurrence.ts`,
  `subscriptions/detect.ts`, `money_leaks/detect.ts`, `import/rollbackImportBatch.ts`.
- Frontend: `pages/{PlannedEvents,Calendar,Subscriptions,Recurring,Dashboard,
  MoneyLeaks}Page.tsx`, `components/subscriptions/CancelImpactCard.tsx`,
  `components/dashboard/RecurringThisMonthTile.tsx`, `hooks/{useForecast,
  useSafeToSpend}.ts`. Shared types in `frontend/src/types/api.ts`
  (PlannedEvent + Subscription DTO blocks).

### Testing

- Migration test: seed both tables, run migration, assert every row mapped with
  correct `kind`, status, RRULE, and uniqueness; assert counts match.
- Reader parity: existing `plannedEvents`, `subscriptions`, `moneyLeaks`,
  `forecast`, `calendar`, `safeToSpend`, `explainMonth`, `dataQuality` tests pass
  unchanged (endpoints stable).
- New: a recurring Expectation (`kind='subscription'`) appears in forecast/calendar
  expansion via `recurrence_rule` exactly as the old subscription did.
- `cancelled` and `statusUncertain` round-trip through the subscriptions endpoint.

### Risks

- **RRULE conversion fidelity** — weekly/monthly cadence must produce an RRULE that
  `expandRecurrence` expands to the same dates the subscription implied. Test both.
- **`user_id` nullability** — confirm no reader assumes non-null `user_id` on
  planned events (grep before migrating).
- **Detection writer cutover** — `refreshDetectedSubscriptions` upsert keyed on
  `(household_id, normalized_name, currency)` must target the partial unique index.

---

## Part B — Proposal-apply unify

### Current

Two transaction-apply paths with the same core but separate code:

- **Chat** — `ai/chat/proposals.ts:431` `applyProposal`: `sequelize.transaction`
  + `FOR UPDATE` lock → kind dispatch (5 kinds) → mutate → status `applied` →
  appends a `role:'tool'` ChatMessage.
- **AI** — `ai/suggestionStore.ts:99` `applyTransactionSuggestion`: **no
  transaction/lock** → set override fields → `recomputeTransactionAmounts` →
  save with revision provenance → score outcome (`accepted`/`edited`).

Both run the identical core: load+authorize Transaction → mutate →
`recomputeTransactionAmounts` → save → mark source applied (spine `:85-91`).

### Design

- Extract a shared `applyToTransaction(txn, patch, { provenance })` helper running
  inside `sequelize.transaction` + row lock. Both paths call it.
- Per-source differences become pluggable hooks:
  - chat: append tool ChatMessage; status `applied`.
  - ai: revision provenance `source:'ai_suggestion'`; outcome scoring
    (`accepted`/`edited`) as *outcome metadata*, lifecycle status maps to the
    Proposal machine `applied`.
- **Keep `ai_suggestions` and `chat_proposals` tables + endpoints separate** —
  consistent with `#378` (writes stay per-source). No schema or endpoint change.
- Bonus fix: the AI path gains the transaction + lock it currently lacks, closing
  a concurrency gap.

### Testing

- Existing chat-apply and ai-apply tests pass unchanged.
- New: both paths produce identical Transaction mutation + recompute for an
  equivalent patch; AI apply is now atomic under concurrent apply.

---

## Sequencing

Independent. **Expectation first** (the migration; highest value, highest risk),
**proposal-apply second** (small, no schema). The spine-doc amendment (Part A
status machine) lands with Part A.

## Open verification items (resolve during implementation, not left as TBD)

- Re-confirm zero incoming FKs to `planned_events` / `subscriptions` immediately
  before the `subscriptions` drop.
- Confirm no reader assumes non-null `planned_events.user_id`.
- Confirm partial-index support on the prod engine and that Sequelize emits it for
  both prod + dev.
