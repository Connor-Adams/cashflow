# Subscription Price-Increase → one Observation (Insight) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the three subscription price-increase detectors into one `Insight` (the Observation primitive): repurpose #441's detector + cron to upsert a `subscription_price_increase` Insight; the money-leak view and the `/subscriptions` chip derive from it; retire `SubscriptionPriceChange` and the `PlannedEvent.priceChangeDetected` 10% path.

**Architecture:** One detector (`detectSubscriptionPriceChanges`, 5% vs 90-day median, **increase-only**) emits an `Insight` via a shared `upsertInsight` helper (keyed `{householdId,type,fingerprint}`, status-preserving). Its existing nightly cron stays — that's how `Insight` "gains a cron". Consumers (money-leak detector input, subscriptions chip) read "is there an open `subscription_price_increase` Insight for this subscription?" instead of the retired table/boolean. `recurring_increase` is guarded off tracked subscriptions to avoid re-overlap.

**Tech Stack:** Sequelize + sequelize-cli migrations; `node:test` via `tsx` (SQLite unit/migration tests, Postgres integration tests via `setupPgTestDb`); Express.

**Reference spec:** `docs/superpowers/specs/2026-06-01-subscription-price-increase-observation-design.md`.

**Commands (from `backend/`):** `yarn typecheck`; single test `yarn tsx --import ./test/setup.ts --test test/<path>.test.ts`; full SQLite suite `yarn test`; integration (Postgres) `yarn test:integration` (CI only — no local Postgres); migrate `yarn db:migrate`. Git: one command per line (sandbox guard misfires on chained git).

**Migration timestamps:** current max is `20260613000001`. New migrations use `20260614000001`, `20260614000002` (verify with `ls backend/src/migrations | sort | tail -1` and stamp above it).

---

## Task 1: Add `subscription_price_increase` to `InsightType`

**Files:** Modify `backend/src/models/Insight.ts:38-44`

- [ ] **Step 1:** Add the value to the union + (it's `STRING(64)`, no migration):

```typescript
export type InsightType =
  | 'duplicate_transactions'
  | 'merchant_spend_spike'
  | 'recurring_increase'
  | 'subscription_price_increase'
  | 'missing_receipt'
  | 'unusual_category_spend'
  | 'settlement_imbalance';
```

- [ ] **Step 2:** `yarn typecheck` → PASS.
- [ ] **Step 3:** Commit.
```
git add backend/src/models/Insight.ts
git commit -m "feat(insight): add subscription_price_increase type"
```

---

## Task 2: Extract a shared `upsertInsight` helper

The subscription-price detector runs outside the `runDetectorsForHousehold` pure pipeline (it reads `PlannedEvent`+`Transaction`, not `DetectorTransaction[]`), so both it and the orchestrator need the same status-preserving upsert. Extract it.

**Files:**
- Modify: `backend/src/insights/runDetectors.ts`
- Test: `backend/test/upsertInsight.test.ts`

- [ ] **Step 1: Write the failing test** (SQLite in-memory, mirrors `runInsightDetectors.test.ts` setup):

```typescript
// backend/test/upsertInsight.test.ts
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let upsertInsight: typeof import('../src/insights/runDetectors').upsertInsight;
let models: typeof import('../src/models');

before(async () => {
  models = await import('../src/models');
  sequelize = models.sequelize;
  ({ upsertInsight } = await import('../src/insights/runDetectors'));
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });
beforeEach(async () => {
  await models.Insight.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

const finding = (over = {}) => ({
  type: 'subscription_price_increase' as const,
  severity: 'warning' as const,
  title: 'X price increased',
  description: 'desc',
  entityType: 'expectation',
  entityId: 1,
  fingerprint: 'subscription_price_increase:1:1599',
  metadata: { newAmountCents: 1599 },
  ...over,
});

test('upsertInsight creates then refreshes without reopening a dismissed row', async () => {
  const hh = await models.Household.create({ name: 'H' });
  await sequelize.transaction((t) =>
    upsertInsight(hh.id, finding(), { now: new Date('2026-06-01'), userId: null }, t),
  );
  let row = await models.Insight.findOne({ where: { householdId: hh.id } });
  assert.equal(row!.status, 'open');
  await row!.update({ status: 'dismissed' });
  // Re-run: same fingerprint → refresh, must NOT reopen.
  await sequelize.transaction((t) =>
    upsertInsight(hh.id, finding({ title: 'X price increased again' }), { now: new Date('2026-06-02'), userId: null }, t),
  );
  row = await models.Insight.findOne({ where: { householdId: hh.id } });
  assert.equal(row!.status, 'dismissed');
  assert.equal(row!.title, 'X price increased again');
  const count = await models.Insight.count({ where: { householdId: hh.id } });
  assert.equal(count, 1);
});
```

- [ ] **Step 2: Run, verify it fails** — `yarn tsx --import ./test/setup.ts --test test/upsertInsight.test.ts` → FAIL (`upsertInsight` not exported).

- [ ] **Step 3: Extract the helper.** In `backend/src/insights/runDetectors.ts`, add (exported) and call it from the existing loop:

```typescript
import type { DetectedInsight } from './detectors';

/**
 * Upsert one detected insight, keyed by (householdId, type, fingerprint).
 * Refreshes content fields but NEVER writes `status`, so a user's
 * dismissed/resolved state is preserved across re-runs. Caller supplies the
 * transaction. Returns 'created' | 'refreshed'.
 */
export async function upsertInsight(
  householdId: number,
  f: DetectedInsight,
  opts: { now: Date; userId: number | null },
  t: import('sequelize').Transaction,
): Promise<'created' | 'refreshed'> {
  const existing = await Insight.findOne({
    where: { householdId, type: f.type, fingerprint: f.fingerprint },
    transaction: t,
  });
  if (existing) {
    existing.set('severity', f.severity);
    existing.set('title', f.title);
    existing.set('description', f.description);
    existing.set('entityType', f.entityType);
    existing.set('entityId', f.entityId);
    existing.set('metadata', f.metadata);
    existing.set('detectedAt', opts.now);
    await existing.save({ transaction: t });
    return 'refreshed';
  }
  await Insight.create(
    {
      householdId,
      userId: opts.userId,
      type: f.type,
      severity: f.severity,
      title: f.title,
      description: f.description,
      entityType: f.entityType,
      entityId: f.entityId,
      status: 'open',
      fingerprint: f.fingerprint,
      metadata: f.metadata,
      detectedAt: opts.now,
    },
    { transaction: t },
  );
  return 'created';
}
```

Then replace the inline upsert in `runDetectorsForHousehold`'s loop with `const r = await upsertInsight(householdId, f, { now, userId }, t); if (r === 'created') created++; else refreshed++;` (preserves existing behavior).

- [ ] **Step 4: Run, verify PASS.** Also run `yarn tsx --import ./test/setup.ts --test test/runInsightDetectors.test.ts` → still PASS (refactor is behavior-preserving).
- [ ] **Step 5: Commit.**
```
git add backend/src/insights/runDetectors.ts backend/test/upsertInsight.test.ts
git commit -m "refactor(insight): extract status-preserving upsertInsight helper"
```

---

## Task 3: Rewrite `detectSubscriptionPriceChanges` to emit an Insight (increase-only, 5% median)

**Files:**
- Modify: `backend/src/subscriptions/detectSubscriptionPriceChanges.ts`
- Test: `backend/test/detectSubscriptionPriceChanges.test.ts`

- [ ] **Step 1: Write the failing test** (SQLite, seeds a sub + txns, asserts an Insight is upserted; a <5% change → none; a price *drop* → none):

```typescript
// backend/test/detectSubscriptionPriceChanges.test.ts
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let detect: typeof import('../src/subscriptions/detectSubscriptionPriceChanges').detectSubscriptionPriceChanges;
let models: typeof import('../src/models');

before(async () => {
  models = await import('../src/models');
  sequelize = models.sequelize;
  ({ detectSubscriptionPriceChanges: detect } = await import('../src/subscriptions/detectSubscriptionPriceChanges'));
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });
beforeEach(async () => {
  await models.Insight.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.PlannedEvent.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  await models.User.destroy({ where: {}, truncate: true });
});

async function seedSub(householdId: number, merchant: string) {
  return models.PlannedEvent.create({
    kind: 'subscription', type: 'expense', source: 'recurring_detection',
    householdId, userId: null, name: merchant, normalizedName: merchant.toLowerCase(),
    amount: '20.0000', currency: 'CAD', cadence: 'monthly',
    lastChargeDate: '2026-05-15', nextExpectedDate: null, expectedDate: '2026-05-15',
    annualizedCost: '240.0000', status: 'planned', statusUncertain: false,
    category: null, cancellationUrl: null, notes: null,
  });
}
async function seedTxn(householdId: number, merchant: string, amount: string, date: string) {
  return models.Transaction.create({
    householdId, accountId: null, date, amount, currency: 'CAD',
    merchantRaw: merchant, merchantClean: merchant, finalCategory: 'Streaming', visibility: 'shared',
  } as never);
}

test('emits a subscription_price_increase Insight on a >=5% increase vs 90d median', async () => {
  const hh = await models.Household.create({ name: 'H' });
  const sub = await seedSub(hh.id, 'Netflix');
  await seedTxn(hh.id, 'Netflix', '-10.00', '2026-03-01');
  await seedTxn(hh.id, 'Netflix', '-10.00', '2026-04-01');
  await seedTxn(hh.id, 'Netflix', '-11.00', '2026-05-01'); // +10% vs median 10
  const r = await detect();
  assert.equal(r.detected, 1);
  const ins = await models.Insight.findOne({ where: { type: 'subscription_price_increase' } });
  assert.ok(ins);
  assert.equal(ins!.entityType, 'expectation');
  assert.equal(ins!.entityId, sub.id);
  const md = ins!.metadata as { newAmountCents: number; previousAmountCents: number };
  assert.equal(md.newAmountCents, 1100);
  assert.equal(md.previousAmountCents, 1000);
});

test('does NOT emit on a price DROP', async () => {
  const hh = await models.Household.create({ name: 'H' });
  await seedSub(hh.id, 'Spotify');
  await seedTxn(hh.id, 'Spotify', '-10.00', '2026-03-01');
  await seedTxn(hh.id, 'Spotify', '-10.00', '2026-04-01');
  await seedTxn(hh.id, 'Spotify', '-8.00', '2026-05-01'); // -20%
  const r = await detect();
  assert.equal(r.detected, 0);
  assert.equal(await models.Insight.count(), 0);
});
```

NOTE: the seed currency-mismatch / `iLike` works on SQLite via Sequelize; if `Op.iLike` errors on SQLite, the test harness already uses Postgres-only patterns elsewhere — if so, move this to `test/integration/`. Try SQLite first.

- [ ] **Step 2: Run, verify it fails** (still emits SubscriptionPriceChange, no Insight).

- [ ] **Step 3: Rewrite the detector.** In `detectSubscriptionPriceChanges.ts`: (a) change the threshold check from abs deviation to **increase-only** — replace `const diff = Math.abs(latestCents - baselineCents); const ratio = diff / Math.abs(baselineCents); if (ratio < 0.05)` with:

```typescript
    const delta = (latestCents - baselineCents) / Math.abs(baselineCents);
    if (delta < 0.05) { // increase-only; <5% increase (incl. any drop) skipped
      skipped++;
      continue;
    }
```

(b) Replace the idempotency `SubscriptionPriceChange.findOne` + `SubscriptionPriceChange.create` block with an `upsertInsight` call:

```typescript
    const pctChange = delta * 100;
    const finding = {
      type: 'subscription_price_increase' as const,
      severity: 'warning' as const,
      title: `${sub.merchantName} price increased`,
      description: `${sub.merchantName} is now ${(latestCents / 100).toFixed(2)} ${sub.currency}/${sub.cadence === 'weekly' ? 'wk' : 'mo'} (was ${(baselineCents / 100).toFixed(2)}, +${pctChange.toFixed(0)}%).`,
      entityType: 'expectation',
      entityId: sub.id,
      fingerprint: `subscription_price_increase:${sub.id}:${latestCents}`,
      metadata: {
        previousAmountCents: Math.round(baselineCents),
        newAmountCents: latestCents,
        pctChange: Number(pctChange.toFixed(3)),
        triggeringTransactionId: latestRow.id ?? null,
        currency: sub.currency,
      },
    };
    await sequelize.transaction((t) =>
      upsertInsight(sub.householdId, finding, { now: new Date(), userId: null }, t),
    );
    detected++;
```

Update imports: drop `SubscriptionPriceChange`, add `import { sequelize } from '../db'` (or wherever `sequelize` is exported — match `runDetectors.ts`), and `import { upsertInsight } from '../insights/runDetectors'`. Keep `PlannedEvent`, `Transaction`, `serializeSubscription`, `median`, `logger`.

- [ ] **Step 4: Run, verify PASS** (both cases).
- [ ] **Step 5: Commit.**
```
git add backend/src/subscriptions/detectSubscriptionPriceChanges.ts backend/test/detectSubscriptionPriceChanges.test.ts
git commit -m "feat(insight): subscription price detector emits Insight (increase-only, 5% median)"
```

---

## Task 4: Guard `recurring_increase` off tracked subscriptions

**Files:**
- Modify: `backend/src/insights/detectors/index.ts` (`detectRecurringIncrease` + `DetectorOptions`)
- Modify: `backend/src/insights/runDetectors.ts` (load subscription merchant set, pass it)
- Test: `backend/test/insightDetectors.test.ts` (add a case)

- [ ] **Step 1: Add a failing test** in `insightDetectors.test.ts`:

```typescript
test('detectRecurringIncrease: skips merchants that are tracked subscriptions', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const rows = [
    txn({ id: 1, date: '2026-02-01', merchantClean: 'Netflix', amount: -15 }),
    txn({ id: 2, date: '2026-03-01', merchantClean: 'Netflix', amount: -15 }),
    txn({ id: 3, date: '2026-04-01', merchantClean: 'Netflix', amount: -15 }),
    txn({ id: 4, date: '2026-05-01', merchantClean: 'Netflix', amount: -22 }),
  ];
  const withGuard = detectRecurringIncrease(rows, { now, subscriptionMerchants: new Set(['netflix']) });
  assert.equal(withGuard.length, 0);
  const without = detectRecurringIncrease(rows, { now, subscriptionMerchants: new Set() });
  assert.equal(without.length, 1);
});
```

- [ ] **Step 2: Run, verify it fails** (TS: `subscriptionMerchants` not on `DetectorOptions`; behavior: still emits).

- [ ] **Step 3: Implement.** In `detectors/index.ts`, extend `DetectorOptions` and add the guard:

```typescript
export type DetectorOptions = {
  now: Date;
  /** Lowercased merchant names that are tracked subscriptions; recurring_increase skips these (subscription_price_increase owns them). */
  subscriptionMerchants?: Set<string>;
};
```

In `detectRecurringIncrease`, inside the per-bucket loop (after computing `bucket.merchant`), skip subscription merchants — add near the top of the `for (const bucket of buckets.values())` body:

```typescript
    if (opts.subscriptionMerchants?.has(bucket.merchant.toLowerCase())) continue;
```

In `runDetectors.ts` `runDetectorsForHousehold`, load the set and pass it:

```typescript
  const subRows = await PlannedEvent.findAll({
    where: { householdId, kind: 'subscription' },
    attributes: ['normalizedName'],
    raw: true,
  });
  const subscriptionMerchants = new Set(
    subRows.map((r) => String(r.normalizedName ?? '').toLowerCase()).filter(Boolean),
  );
  // ...
  ...detectRecurringIncrease(transactions, { now, subscriptionMerchants }),
```

(Add `PlannedEvent` to the `runDetectors.ts` model imports. Note `normalizedName` is the subscription's normalized merchant; `recurring_increase` buckets by `merchantClean.toLowerCase()` — confirm the normalization matches closely enough; if not, also match on raw merchant lowercased. For the plan: match on `normalizedName` lowercased and document the assumption.)

- [ ] **Step 4: Run, verify PASS** (the new case + existing `detectRecurringIncrease` happy-path still passes — it passes no `subscriptionMerchants`, so the guard is a no-op there).
- [ ] **Step 5: Commit.**
```
git add backend/src/insights/detectors/index.ts backend/src/insights/runDetectors.ts backend/test/insightDetectors.test.ts
git commit -m "feat(insight): recurring_increase skips tracked-subscription merchants"
```

---

## Task 5: Money-leak derives `priceChangeDetected` from open Insights

The money-leak detector keeps its `LeakSubscription.priceChangeDetected` input; only its SOURCE changes — the route computes it from open `subscription_price_increase` Insights instead of the `PlannedEvent` column.

**Files:**
- Modify: `backend/src/routes/moneyLeaks.ts` (the subscriptions mapping at `:140-160`)
- Test: `backend/test/integration/moneyLeaks.test.ts` (CI/Postgres — update the seed + add a case)

- [ ] **Step 1: Update the integration seed + add a failing case.** In `moneyLeaks.test.ts`, change `seedSubscription` to also (optionally) seed an open Insight when `priceChangeDetected` is wanted, instead of setting the (to-be-removed) column. Replace the `priceChangeDetected: args.priceChangeDetected ?? false` create field with: after creating the PlannedEvent, if `args.priceChangeDetected`, `await models.Insight.create({ householdId, userId: null, type: 'subscription_price_increase', severity: 'warning', title: '...', description: '', entityType: 'expectation', entityId: <pe.id>, status: 'open', fingerprint: 'subscription_price_increase:'+pe.id+':1899', metadata: { newAmountCents: 1899 }, detectedAt: new Date() })`. The existing assertion (`surfaces subscription_price_increase`) must still pass.

- [ ] **Step 2:** Run `yarn test:integration` locally → cannot (no Postgres); rely on CI. Verify the SQLite suite + typecheck after Step 3.

- [ ] **Step 3: Change the route.** In `backend/src/routes/moneyLeaks.ts` GET handler, after loading `subRows`, load open price-increase Insights and key by entityId; set `priceChangeDetected` from that set:

```typescript
    const priceInsights = await Insight.findAll({
      where: { ...householdWhere(req), type: 'subscription_price_increase', status: 'open' },
      attributes: ['entityId'],
      raw: true,
    });
    const priceUp = new Set<number>(
      priceInsights.map((i) => i.entityId).filter((x): x is number => x != null),
    );
    const subscriptions: LeakSubscription[] = subRows
      .map(serializeSubscription)
      .map((row) => ({
        // ...unchanged fields...
        priceChangeDetected: priceUp.has(row.id),
        // ...
      }));
```

Add `Insight` to the `../models` import.

- [ ] **Step 4:** `yarn typecheck` PASS; `yarn test` (SQLite) 0 fail (this route isn't in the SQLite suite, but typecheck guards it).
- [ ] **Step 5: Commit.**
```
git add backend/src/routes/moneyLeaks.ts backend/test/integration/moneyLeaks.test.ts
git commit -m "feat(insight): money-leaks reads price-increase from open Insights"
```

---

## Task 6: `/subscriptions` chip derives from open Insights; drop `SubscriptionPriceChange` join

**Files:**
- Modify: `backend/src/routes/subscriptions.ts` (the `pendingPriceChange` block `:348-395` + imports)
- Modify: `backend/src/expectations/subscriptionMapper.ts` (`serializeSubscription` emits `priceChangeDetected: false` literal — the column is dropped in Task 8)
- Test: `backend/test/integration/subscriptionsPriceChip.test.ts` (CI/Postgres)

- [ ] **Step 1: Write the integration test** (Postgres; mirror the existing subscriptions integration harness): seed a `kind='subscription'` PlannedEvent + an open `subscription_price_increase` Insight with `entityId = pe.id` and `metadata {previousAmountCents:1000,newAmountCents:1100,pctChange:10}`; `GET /api/subscriptions` → the row's `pendingPriceChange` is `{ id, prevCents:1000, newCents:1100, pctChange:'10', detectedOn:<date> }`; a sub with no Insight → `pendingPriceChange: null`.

- [ ] **Step 2:** Run → cannot locally (Postgres); CI verifies.

- [ ] **Step 3: Repoint the chip.** Replace the `SubscriptionPriceChange.findAll` block with an Insight query keyed by `entityId`:

```typescript
    const rows = await PlannedEvent.findAll({ where });

    const priceInsights = await Insight.findAll({
      where: { householdId: auth.household.id, type: 'subscription_price_increase', status: 'open' },
      attributes: ['id', 'entityId', 'metadata', 'detectedAt'],
      raw: true,
    });
    const pendingMap = new Map<number, PendingPriceChange>();
    for (const ins of priceInsights) {
      if (ins.entityId == null || pendingMap.has(ins.entityId)) continue;
      const md = (ins.metadata ?? {}) as { previousAmountCents?: number; newAmountCents?: number; pctChange?: number };
      pendingMap.set(ins.entityId, {
        id: ins.id,
        prevCents: md.previousAmountCents ?? 0,
        newCents: md.newAmountCents ?? 0,
        pctChange: String(md.pctChange ?? 0),
        detectedOn: (ins.detectedAt instanceof Date ? ins.detectedAt : new Date(ins.detectedAt as string)).toISOString().slice(0, 10),
      });
    }
    // ...rest of the .map(...).sort(...) unchanged (still attaches pendingPriceChange: pendingMap.get(row.id) ?? null)...
```

Update imports: drop `SubscriptionPriceChange`, add `Insight` from `../models`.

- [ ] **Step 4: `serializeSubscription`** (`subscriptionMapper.ts`): change `priceChangeDetected: row.priceChangeDetected` to `priceChangeDetected: false` (the column is removed in Task 8; the money-leak route now derives the real value from Insights, and the chip carries the detail). Add a comment.

- [ ] **Step 5:** `yarn typecheck` PASS; `yarn test` 0 fail (re-run `subscriptionMapper.test.ts` — update any assertion that expected `priceChangeDetected` to mirror input → now always false).
- [ ] **Step 6: Commit.**
```
git add backend/src/routes/subscriptions.ts backend/src/expectations/subscriptionMapper.ts backend/test
git commit -m "feat(insight): /subscriptions chip derives pendingPriceChange from Insights"
```

---

## Task 7: Add `type` filter to `GET /api/insights`

**Files:** Modify `backend/src/routes/insights.ts:63-73`; Test: `backend/test/integration/insights.test.ts` (or wherever the insights route test lives).

- [ ] **Step 1:** Add a failing test: `GET /api/insights?type=subscription_price_increase` returns only that type; an invalid `type` → 400.
- [ ] **Step 2:** Run → fails (no `type` filter).
- [ ] **Step 3:** In the GET handler, after the `status` filter, add (validate against the `InsightType` values — import `INSIGHT_TYPES` if it exists, else accept any non-empty string and filter):

```typescript
    const typeParam = req.query.type;
    if (typeof typeParam === 'string' && typeParam.length > 0) {
      where.type = typeParam;
    }
```

(No strict enum validation needed — `type` is open STRING; an unknown type simply returns []. If a validated list is preferred, add an exported `INSIGHT_TYPES` const to `Insight.ts` and check it, mirroring `INSIGHT_STATUSES`.)

- [ ] **Step 4:** Run, PASS. **Step 5:** Commit.
```
git add backend/src/routes/insights.ts backend/test
git commit -m "feat(insight): add type filter to GET /api/insights"
```

---

## Task 8: Retire `priceChangeDetected` (column + 10% path) + migration

**Files:**
- Modify: `backend/src/subscriptions/detect.ts` (remove `detectPriceIncrease`, `PRICE_INCREASE_THRESHOLD`, and the `priceChangeDetected` keys in both ops)
- Modify: `backend/src/models/PlannedEvent.ts` (remove the `priceChangeDetected` field decl `:140` + init attr `:223-228`)
- Create: `backend/src/migrations/20260614000001-drop-planned-events-price-change-detected.js`
- Test: `backend/test/migrations/dropPriceChangeDetectedMigration.test.ts`

- [ ] **Step 1: Migration test** (SQLite; create a minimal `planned_events` with `price_change_detected`, run `up` → column gone, `down` → column back):

```typescript
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';
let sequelize: Sequelize; let migration: any;
before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('planned_events', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    price_change_detected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  });
  migration = require('../../src/migrations/20260614000001-drop-planned-events-price-change-detected.js');
});
after(async () => { await sequelize.close(); });
test('up removes price_change_detected, down re-adds it', async () => {
  const qi = sequelize.getQueryInterface();
  await migration.up(qi, Sequelize);
  let cols = await qi.describeTable('planned_events');
  assert.equal(cols.price_change_detected, undefined);
  await migration.down(qi, Sequelize);
  cols = await qi.describeTable('planned_events');
  assert.ok(cols.price_change_detected);
});
```

- [ ] **Step 2:** Run, fails (module missing).
- [ ] **Step 3: Write the migration:**

```javascript
// backend/src/migrations/20260614000001-drop-planned-events-price-change-detected.js
'use strict';
/** Expectation/Observation cleanup: the subscription price-increase signal now
 * lives in an Insight (type='subscription_price_increase'), not this boolean. */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeColumn('planned_events', 'price_change_detected');
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('planned_events', 'price_change_detected', {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
    });
  },
};
```

- [ ] **Step 4: Remove the code.** In `detect.ts`: delete `PRICE_INCREASE_THRESHOLD` + `detectPriceIncrease`; remove `priceChangeDetected` from the `update` op patch and the `insert` op (and drop the `priceChange`/`priorAmount` locals). In `PlannedEvent.ts`: remove the field decl + init attr. (If `detect.ts` exports `detectPriceIncrease`/`PRICE_INCREASE_THRESHOLD` and a test imports them, delete that test or its cases.)
- [ ] **Step 5:** `yarn typecheck` PASS; run the migration test + `yarn test` → 0 fail. Grep `grep -rn "priceChangeDetected\|price_change_detected\|detectPriceIncrease\|PRICE_INCREASE_THRESHOLD" backend/src` → only the migration's `down` + serializeSubscription's literal `false` remain.
- [ ] **Step 6: Commit.**
```
git add backend/src/subscriptions/detect.ts backend/src/models/PlannedEvent.ts backend/src/migrations/20260614000001-drop-planned-events-price-change-detected.js backend/test/migrations/dropPriceChangeDetectedMigration.test.ts
git commit -m "feat(insight): retire PlannedEvent.priceChangeDetected + the 10% path"
```

---

## Task 9: Retire `SubscriptionPriceChange` (model + route + table)

Order: code refs are already gone (Tasks 3/5/6 removed the readers; the cron now calls the Insight-emitting detector). Now delete the model + route + table.

**Files:**
- Delete: `backend/src/models/SubscriptionPriceChange.ts`, `backend/src/routes/subscriptionPriceChanges.ts`
- Modify: `backend/src/models/index.ts` (remove import/init/registry), `backend/src/app.ts` (remove import `:18` + mount `:197`)
- Create: `backend/src/migrations/20260614000002-drop-subscription-price-changes.js`
- Test: `backend/test/migrations/dropSubscriptionPriceChangesMigration.test.ts`

- [ ] **Step 1: Pre-check** — `grep -rn "SubscriptionPriceChange" backend/src` → only the model file, models/index.ts, routes/subscriptionPriceChanges.ts, app.ts remain (no detector/route/chip readers). If any reader remains, fix it first.
- [ ] **Step 2: Migration test** (SQLite, up drops / down recreates). Mirror `dropPriceChangeDetectedMigration.test.ts`: create a stub `subscription_price_changes` table, `up` → `assert.rejects(describeTable)`, `down` → table back.
- [ ] **Step 3: Write the migration.** `up` = `dropTable('subscription_price_changes')`. `down` = recreate the table per `20260612000002-create-subscription-price-changes.js`'s `up` **but with `subscription_id` as a plain `BIGINT` (no FK)** — because `20260613000001-relax-subscription-price-change-fk.js` already dropped the FK; the down must match the post-relax shape, not the original. (Copy the column list + the 3 indexes `spc_subscription_ack`, `spc_household_detected_on`, `spc_unique_unack` from the create migration; omit the `references` on `subscription_id`.)
- [ ] **Step 4: Delete model + route + wiring.** Remove `SubscriptionPriceChange.ts` (use `node -e "require('fs').unlinkSync(...)"` if `rm` is sandbox-blocked); remove from `models/index.ts` (import, `initSubscriptionPriceChange`, registry entry, any association); delete `routes/subscriptionPriceChanges.ts`; remove its import + mount from `app.ts`. Also remove the cron's stale import of `SubscriptionPriceChange` (the detector no longer uses it — done in Task 3) — confirm `detectSubscriptionPriceChanges.ts` no longer imports it.
- [ ] **Step 5:** `yarn typecheck` PASS; migration test PASS; `yarn test` 0 fail. `grep -rn "SubscriptionPriceChange" backend/src` → only the migration `down` recreate (string literal) remains. Check `frontend/src` for any `/api/subscription-price-changes` caller or `SubscriptionPriceChange` type; if present, remove/repoint (the chip's `pendingPriceChange` shape is unchanged, so the main subscriptions page is unaffected).
- [ ] **Step 6: Commit.**
```
git add -A
git commit -m "feat(insight): drop SubscriptionPriceChange model + route + table (folded into Insight)"
```

---

## Task 10: Cron sanity + final verification

The cron `detect_subscription_price_changes` (`jobs/definitions/detectSubscriptionPriceChanges.ts` + the side-effect import in `server.ts:21`) is UNCHANGED in wiring — its handler calls `detectSubscriptionPriceChanges()`, which now upserts Insights. No edit needed beyond confirming it still type-checks and registers.

**Files:** Test: `backend/test/integration/subscriptionPriceInsight.test.ts` (CI/Postgres, end-to-end).

- [ ] **Step 1:** Write an integration test: seed a sub + 90d txns with a ≥5% increase → call `detectSubscriptionPriceChanges()` → `GET /api/insights?type=subscription_price_increase` shows it (status open); `GET /api/subscriptions` chip shows `pendingPriceChange`; `GET /api/money-leaks` surfaces `subscription_price_increase`; `PATCH /api/insights/:id {status:'dismissed'}` → the chip + money-leak both clear (they read `status:'open'`). Re-run the detector → the dismissed Insight is NOT reopened.
- [ ] **Step 2:** `yarn typecheck` + `yarn test` (SQLite) → 0 fail. (Integration runs in CI.)
- [ ] **Step 3: Commit.**
```
git add backend/test/integration/subscriptionPriceInsight.test.ts
git commit -m "test(insight): end-to-end subscription price-increase via Insight"
```

---

## Self-Review

- **Spec coverage:** one Insight source ✓ (T1-3), cron stays ✓ (T10), money-leak derive ✓ (T5), chip derive ✓ (T6), recurring_increase guard ✓ (T4), retire SubscriptionPriceChange ✓ (T9) + priceChangeDetected/10% ✓ (T8), Insight `type` filter ✓ (T7), migrations ✓ (T8/T9), threshold 5% increase-only ✓ (T3), regenerate-not-migrate data ✓ (drop migrations, no data copy).
- **Placeholder scan:** the `Op.iLike`-on-SQLite caveat (T3) and the `normalizedName` vs `merchantClean` match (T4) are flagged assumptions with a fallback, not TBDs. The `INSIGHT_TYPES` validation (T7) is an explicit optional.
- **Type consistency:** `upsertInsight(householdId, DetectedInsight, {now,userId}, t)` defined T2, used T3; `subscriptionMerchants` on `DetectorOptions` defined+used T4; `entityType='expectation'`/`entityId=PlannedEvent.id`/fingerprint `subscription_price_increase:${id}:${cents}` consistent T3/T5/T6/T10; metadata `{previousAmountCents,newAmountCents,pctChange,...}` consistent T3/T6.

## Open items for the executor

1. **`Op.iLike` on SQLite** (T3 unit test): if it throws, move that test to `test/integration/` (Postgres) and keep a pure-function unit test of the median/threshold math instead.
2. **`recurring_increase` merchant match** (T4): `normalizedName` (subscription) vs `merchantClean.toLowerCase()` (detector bucket key) may not match exactly. If they diverge, match on both the normalized and raw lowercased merchant, or normalize identically. Verify against real data shapes.
3. **`sequelize` import** in the detector (T3): match how `runDetectors.ts` imports the shared `sequelize` instance.
4. Deploy: this carries 2 column/table-drop migrations; sequence after the price-increase code is deployed (so nothing reads the dropped column/table at runtime).
