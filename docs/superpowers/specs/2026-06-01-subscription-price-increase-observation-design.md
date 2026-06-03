# Subscription Price-Increase → one Observation (Insight)

**Date:** 2026-06-01
**Status:** Approved (brainstorm); pending spec review
**Type:** Spine convergence (Observation primitive) + 3-way dedup
**Reference:** `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md` (Observation primitive)

## Problem

"A subscription got more expensive" is currently detected in **three independent
places**, three thresholds, none wired together:

| Detector | Threshold | Mechanism | Lifecycle |
|---|---|---|---|
| `SubscriptionPriceChange` (#441) | 5% vs 90d **median** | persisted table + **nightly cron** | `acknowledgedAt` (2-state) |
| money-leak `subscription_price_increase` | 10% vs prior amount | derived on-read; reads `PlannedEvent.priceChangeDetected` boolean | `MoneyLeakDismissal` |
| `Insight` `recurring_increase` | 20% vs 3-mo avg | on-demand (`POST /api/insights/run`) | open→dismissed→resolved |

`SubscriptionPriceChange` is **off-spine**: a status-machine (open→acknowledged) +
noun that mirrors `Insight` (the Observation primitive) but was built as a parallel
table hard-keyed to a subscription id. The redundancy — not just its shape — is the
target.

## Decision

**One source of truth: an `Insight`.** A single detector emits a
`subscription_price_increase` Insight; the money-leak view and the `/subscriptions`
price chip both *derive* from it; `SubscriptionPriceChange` and the duplicate
`detect.ts` 10% flag are retired. Threshold: **5% vs 90-day median** (preserve
#441's precision — approved).

## Design

### The single detector → Insight

Repurpose the existing `#441` detector + cron rather than build new scheduling:
- `backend/src/subscriptions/detectSubscriptionPriceChanges.ts` keeps its detection
  logic (per `kind='subscription'` PlannedEvent: median of prior 90d charges, fire
  at **≥5% increase** — change from abs-deviation to **increase-only**, since a
  price *drop* is not an Observation worth surfacing), but **changes its sink**: it
  upserts an `Insight` instead of inserting a `SubscriptionPriceChange` row.
- The existing nightly cron `detect_subscription_price_changes`
  (`backend/src/jobs/definitions/detectSubscriptionPriceChanges.ts`, cadence
  `env.subscriptionPriceDetectCron`) stays — it now feeds `Insight`. **This is how
  `Insight` "gains a cron" without restructuring `runDetectors`.**

Insight row shape (`backend/src/models/Insight.ts`):
- `type = 'subscription_price_increase'` (new value; `type` is `STRING(64)`, no
  enum migration needed — add to the TS union + any validator list).
- `entityType = 'expectation'`, `entityId =` the PlannedEvent id.
- `severity = 'warning'`.
- `fingerprint = 'subscription_price_increase:' + expectationId + ':' + newAmountCents`
  — replaces #441's runtime "unacknowledged row exists" dedup. The
  `runDetectors`-style upsert on `(household_id, type, fingerprint)` preserves user
  status across re-runs (won't reopen a dismissed/resolved row).
- `status` open→dismissed/resolved replaces `acknowledgedAt` (acknowledge = set
  `dismissed`). `acknowledgedByUserId` has no first-class column → store in
  `metadata` if the audit is wanted; otherwise dropped (it's ephemeral detector
  output).
- `metadata = { previousAmountCents, newAmountCents, pctChange, triggeringTransactionId, currency }`
  — the typed columns #441 had become JSON here (acceptable; consumers reshape).
- `title`/`description`: e.g. `"<merchant> price increased <pct>%"`.

The detector writes Insights via the same status-preserving upsert
`runDetectors` uses (`backend/src/insights/runDetectors.ts:96-170`), or a small
shared `upsertInsight(household, {type, fingerprint, ...})` helper if the detector
runs outside the `runDetectors` pipeline. (Implementation detail for the plan; the
contract is: upsert by `(household_id, type, fingerprint)`, never reopen a
user-cleared row.)

### Everything else derives from that Insight

- **money-leak** (`backend/src/money_leaks/detect.ts:230-259`): replace the
  `sub.priceChangeDetected` boolean read with "is there an **open**
  `Insight type='subscription_price_increase'` for this subscription
  (`entityId = sub.id`)?". Dollar-impact ($/mo, $/yr) + the dedup-priority chain
  stay in the money-leak view (computed from the subscription's `annualizedCost`,
  as today). `MoneyLeakDismissal` (view-level dismissal, keyed by subscriptionId)
  is unchanged.
- **`/subscriptions` chip** (`backend/src/routes/subscriptions.ts:352-387`):
  `pendingPriceChange` reads the open `subscription_price_increase` Insight for
  `entityId = row.id`, reshaping `{ id, prevCents, newCents, pctChange, detectedOn }`
  from the Insight (`metadata` + `detectedAt`). Drop the `SubscriptionPriceChange`
  join.
- **`recurring_increase`** (`backend/src/insights/detectors/index.ts:246-320`): add
  a guard to **skip merchants that are tracked subscriptions** (normalized name
  matches a `kind='subscription'` PlannedEvent for the household), so it remains the
  *non-subscription* recurring catch and doesn't re-introduce overlap.

### Insight `type` filter

`/api/insights` currently filters only by status/severity
(`backend/src/routes/insights.ts:63-87`). Add an optional `?type=` filter so the
chip/list can query `subscription_price_increase` specifically.

### Retire

- Model `backend/src/models/SubscriptionPriceChange.ts` + its `models/index.ts`
  registration.
- Route `backend/src/routes/subscriptionPriceChanges.ts` + its `app.ts` mount.
- The `SubscriptionPriceChange` read/join in `routes/subscriptions.ts`.
- Column `PlannedEvent.priceChangeDetected` (model + a `removeColumn` migration).
- `detect.ts` `detectPriceIncrease` (the 10% path) + its writes of
  `priceChangeDetected` in `mergeDetectionWithExisting`.
- Keep the detector FILE + cron (repurposed to write Insights, above).

### Migrations

Two migrations (timestamps **after the current max** — executor runs
`ls backend/src/migrations | sort | tail -1` and stamps above it):
1. `drop-subscription-price-changes` — `dropTable('subscription_price_changes')`.
   `down` recreates it (copy the `up` of `20260612000002-create-subscription-price-changes.js`).
   Rows are ephemeral (regenerated by the cron into Insights) → no data migration.
2. `drop-planned-events-price-change-detected` — `removeColumn('planned_events',
   'price_change_detected')`. Sequelize rebuilds the table on SQLite and emits
   `DROP COLUMN` on Postgres — both supported. `down` re-adds the column
   (`BOOLEAN NOT NULL DEFAULT false`).

### Data / first run

Existing `subscription_price_changes` rows are dropped (ephemeral). On the next
cron run (or `POST /api/insights/run`), the detector repopulates
`subscription_price_increase` Insights from current data. The money-leak + chip go
empty until that first run — acceptable (detector output, not user data).

## Blast radius

- Backend: `models/{Insight,SubscriptionPriceChange,PlannedEvent}.ts`,
  `models/index.ts`, `subscriptions/detectSubscriptionPriceChanges.ts`,
  `subscriptions/detect.ts`, `routes/{subscriptions,subscriptionPriceChanges,insights,moneyLeaks}.ts`,
  `money_leaks/detect.ts`, `insights/detectors/index.ts`, `insights/runDetectors.ts`
  (maybe), `jobs/definitions/detectSubscriptionPriceChanges.ts`, 2 migrations.
- Frontend: the `pendingPriceChange` chip shape is **preserved** (same fields), so
  no frontend change. Verify the `SubscriptionPriceChange` types in
  `frontend/src/types/api.ts` aren't referenced elsewhere; if the dedicated
  `/api/subscription-price-changes` page/route had a frontend caller, repoint or
  remove it.

## Testing

- **Detector unit** (SQLite): seed a `kind='subscription'` PlannedEvent + 90d of
  txns with a ≥5% median increase → asserts one `subscription_price_increase`
  Insight upserted (fingerprint, entityType/entityId, metadata cents); a <5%
  change → none; a price *drop* → none; re-run preserves a dismissed Insight.
- **money-leak derive** (integration, Postgres): an open price-increase Insight →
  `/api/money-leaks` surfaces `subscription_price_increase` with dollar-impact;
  dismissing via `MoneyLeakDismissal` hides it; no Insight → not surfaced.
- **chip** (integration): `/api/subscriptions` `pendingPriceChange` reflects the
  open Insight; reshaped fields match the legacy shape.
- **recurring_increase guard** (unit): a tracked-subscription merchant does NOT
  emit a `recurring_increase` Insight (only `subscription_price_increase`); a
  non-subscription merchant still does.
- **migrations** (SQLite up/down): table drop + column drop round-trip.
- **retirement**: `grep` shows no live refs to `SubscriptionPriceChange` model or
  `priceChangeDetected`; `/api/subscription-price-changes` route gone.

## Risks

- **Threshold shift**: money-leak previously fired at 10%; now the signal is the
  5% Insight → **more price-increase money-leaks surface**. Intended (precision),
  but a visible behavior change — call it out in the PR.
- **Cron sink swap**: the detector's output target changes; ensure the cron still
  registers + runs and that the upsert preserves user status (don't resurrect
  dismissed Insights every night).
- **SQLite `removeColumn`**: rebuilds the table — confirm the migration test
  round-trips and no FK/index is lost on `planned_events`.
- **`recurring_increase` guard**: needs the subscription set per household;
  ensure it doesn't suppress legitimate non-subscription recurring increases.

## Out of scope

Part B (proposal-apply unify), M3 (drop `subscriptions` table) remain separate.
This spec does not touch the Expectation fold (already merged).
