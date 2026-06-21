# Cashflow Spine Folds — Expectation merge + proposal-apply unify

**Date:** 2026-05-31
**Status:** Approved; refined post-grounding 2026-05-31
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

**Approach: fold the model/table only — keep every route, page, and DTO shape.**
The handlers for `/planned-events`, `/subscriptions`, `/recurring`,
`/money-leaks`, `/calendar` keep their URLs; their serializers map the merged rows
back to today's response shapes, so **the frontend is unchanged**. This is a
backend-internal fold. Behaviour is preserved by every reader filtering on `kind`
— `kind='planned'` consumers (forecast, calendar, safe-to-spend, CFO, AI review,
financial scenarios, debt, credit-card) see exactly what they see today;
`kind='subscription'` consumers (subscriptions, money-leaks, reports) likewise.

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

**This amends the adopted spine.** The plan must update `primitives-design.md:70`
to `planned → posted → skipped / ignored / cancelled` and note the addition; also
reconcile the convergence-path note (`:163`, "add cadence") — `cadence` is indeed
kept as a column (see Schema). Flagged as a spine change, not silent.

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
| Subscription | unknown | planned | + `status_uncertain = true` |

`posted` / `skipped` apply only to one-shot rows; recurring rows are standing
(individual occurrences are derived, not persisted), so they live in `planned`
until `ignored`/`cancelled`.

### Schema

`expectations` (initially still `planned_events` — see Migration) = current
`planned_events` columns (unchanged) plus:

| New column | Type | Purpose |
|---|---|---|
| `kind` | STRING(16) NOT NULL default `'planned'` | discriminator `'planned' \| 'subscription'` |
| `cadence` | STRING(16) null | subscription billing cadence (weekly/monthly/quarterly/semiannual/annual) |
| `normalized_name` | STRING(255) null | subscription identity (detection + unique index) |
| `last_charge_date` | DATEONLY null | subscription last-seen charge |
| `next_expected_date` | DATEONLY null | subscription next-expected charge (lossless; distinct from `expected_date`) |
| `annualized_cost` | DECIMAL(14,4) null | subscription rollup |
| `price_change_detected` | BOOLEAN not-null default false | subscription alert |
| `cancellation_url` | TEXT null | subscription |
| `category` | STRING(128) null | subscription category |
| `status_uncertain` | BOOLEAN not-null default false | carries Subscription `unknown` |

Existing-column reuse for subscription data (no new column needed):

| Subscription field | → Expectation column |
|---|---|
| `merchantName` | `name` |
| `amount`, `currency`, `notes`, timestamps | same-named columns |

**Recurrence representation:** `recurrence_rule` (RRULE) stays the recurrence field
for `kind='planned'` rows; `cadence` is the recurrence field for
`kind='subscription'` rows. They are `kind`-gated — not two sources of truth for
one row — and this exactly matches today's behaviour (planned readers expand
`recurrence_rule`; subscription readers read `cadence`). No RRULE conversion. This
reverses an earlier "recurrence_rule canonical" call: that was justified by
subscriptions riding the forecast expanders for free, but behaviour-preservation
requires `kind`-filtering, so subscriptions never enter those expanders — leaving
conversion as pure added risk (5 cadence values, `annualized_cost` re-derivation).

Backfill (NOT NULL preserved — **no `ALTER COLUMN`**, which SQLite can't do without
a table rebuild) for `kind='subscription'` rows:

- `user_id` ← the household's owner `HouseholdMember.userId` (subscriptions are
  household-scoped; pick the owner). Stays NOT NULL.
- `expected_date` ← `next_expected_date ?? last_charge_date` (`last_charge_date` is
  always present on a Subscription). Stays NOT NULL.
- `type` ← `'expense'`; `source` ← `'recurring_detection'` (already a valid
  `PlannedEventSource`); `account_id`, `linked_transaction_id` ← null.

Index: add partial unique index `(household_id, normalized_name, currency) WHERE
kind = 'subscription'` (preserves the current `subscriptions` uniqueness without
constraining planned rows). Sequelize `addIndex(..., { where: { kind:
'subscription' }, unique: true })` emits a partial index on both Postgres (prod)
and SQLite (dev/test).

### MoneyLeak / dismissals

- **No `MoneyLeak` table** — leak rows stay derived views (`money_leaks/detect.ts`
  recomputes on read). Correct per spine `:95`.
- **`money_leak_dismissals` stays its own table.** 3 of 5 leak types
  (`recurring_fee`, `duplicate_service`, `delivery_fee_high`) dismiss a *derived
  pattern* with no Expectation row to flag — Observation-shaped, not an Expectation
  field. Do not fold it.

### Migration (prod-safe; additive, reversible until final drop)

Two phases so the risky data move is separate from cosmetic renaming, and each
phase is independently shippable.

**Phase A1 — absorb (data fold; table stays `planned_events`):**

1. Migration M1: add the new columns to `planned_events`; backfill existing rows
   `kind='planned'`; add the partial unique index. (No data copy yet.)
2. Model + code: `PlannedEvent` gains the new fields; `subscriptions` route
   reads/writes `planned_events` with `kind='subscription'`; its serializer maps
   merged rows back to the existing Subscription DTO. Other subscription readers
   (money-leaks, reports) switch to the merged model. Planned readers add an
   explicit `kind='planned'` filter (behaviour-preserving).
3. Migration M2: copy `subscriptions` rows into `planned_events` as
   `kind='subscription'` with the field mapping + status reconciliation + backfill
   above. Run with code already handling `kind` so no writes are lost.
4. Verify parity (counts + endpoint spot-checks per household).
5. Migration M3: **drop `subscriptions`.** The irreversible step — only after
   parity. Steps 1–4 leave `subscriptions` untouched, so rollback before M3 is a
   reader/writer revert.

**Phase A2 — rename (cosmetic; optional, separately shippable):**

6. Migration M4: `renameTable('planned_events', 'expectations')`. Rename the model
   `PlannedEvent` → `Expectation` and update imports across the ~14 backend files
   (mechanical; no data risk). Endpoints + DTOs unchanged.

### Blast radius

14 backend files touch `PlannedEvent`, 9 touch `Subscription` (3 type-only).
**Frontend: none** (endpoints + DTOs preserved). **Zero incoming FKs** to either
table (only Sequelize associations; `PlannedEvent.linked_transaction_id` points
outward) — nothing cascades on rename/drop. **Re-verify the no-FK claim
immediately before M3.**

Key touch-points:
- Backend model: `models/PlannedEvent.ts`, `models/Subscription.ts`,
  associations in `models/index.ts:502-535` (PlannedEvent: Household/User/Account/
  Transaction) and `:564-570` (Subscription: Household only). The two
  `Household.hasMany` aliases (`as: 'plannedEvents'`, `as: 'subscriptions'`)
  reconcile to one `as: 'expectations'` (update any eager-load `include` that uses
  the old aliases).
- Backend readers: `routes/{plannedEvents,calendar,subscriptions,moneyLeaks,
  reports,financialScenarios,forecast,debt,creditCards}.ts`,
  `cashflow/safeToSpend.ts`, `cfo/briefingBuilder.ts`, `ai/reviewRunner.ts`,
  `summary/{dataQuality,explainMonth}.ts`, `forecast/expandRecurrence.ts`,
  `subscriptions/detect.ts`, `money_leaks/detect.ts`, `import/rollbackImportBatch.ts`.
- Sole subscription writer: `refreshDetectedSubscriptions` (`routes/subscriptions.ts:170-273`).
- Planned writers: `routes/debt.ts` (`source:'debt'`), `routes/creditCards.ts`
  (`source:'credit_card'`), `routes/plannedEvents.ts` CRUD.

### Testing

Test infra (verbatim-confirmed): backend uses `node:test` via `tsx`. Unit +
migration tests: `yarn test` (SQLite in-memory). Integration tests:
`yarn test:integration` (real Postgres via `setupPgTestDb`). Migrations:
`yarn db:migrate` (sequelize-cli).

- Migration test (mirror `test/migrations/plannedEventsMigration.test.ts`, SQLite
  `:memory:`): M1 adds columns with correct nullability + partial unique index;
  M2 maps every subscription row (status, cadence, dates, owner `user_id`); M3
  drops cleanly. Run `up`/`down`.
- Integration parity (mirror `test/integration/plannedEvents.test.ts`, Postgres,
  `seed()` + session-cookie `request.agent`): `/api/subscriptions`,
  `/api/subscriptions/summary`, `/api/money-leaks`, `/api/planned-events`,
  `/api/forecast`, `/api/calendar` return byte-identical shapes pre/post fold.
- New: a `kind='subscription'` row does NOT appear in `/api/forecast` or
  `/api/calendar` (kind filter holds); `cancelled` + `status_uncertain` round-trip
  through `/api/subscriptions`.

### Risks

- **`expected_date` backfill** — `last_charge_date` is the guaranteed-present
  fallback; assert non-null post-M2.
- **Owner `user_id` lookup** — every household must have an owner
  `HouseholdMember`; assert during M2, fail loudly if missing.
- **Partial unique index** — confirm Sequelize emits the `WHERE kind='subscription'`
  clause on both engines; test a duplicate insert is rejected only for subscriptions.
- **Reader leakage** — the chief behavioural risk is a planned reader forgetting
  the `kind='planned'` filter and picking up subscriptions. The forecast/calendar
  parity tests above are the guard.

---

## Part B — proposal-apply unify

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

Independent, and split into two plans (one per fold). **Expectation first** (the
migration; highest value, highest risk), **proposal-apply second** (small, no
schema). Within Expectation, Phase A1 (absorb) ships before Phase A2 (rename). The
spine-doc amendment lands with Phase A1.

## Open verification items (resolve during implementation, not left as TBD)

- Re-confirm zero incoming FKs to `planned_events` / `subscriptions` immediately
  before M3.
- Confirm every household has an owner `HouseholdMember` before M2 (owner backfill
  for subscription `user_id`).
- Confirm Sequelize emits the partial `WHERE kind='subscription'` unique index on
  Postgres and SQLite.
