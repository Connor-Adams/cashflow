# Expectation Merge Implementation Plan (Phase A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold `Subscription` into the `PlannedEvent` table as `kind='subscription'` rows (the **Expectation** primitive), preserving every endpoint, DTO, and behaviour, then drop the `subscriptions` table.

**Architecture:** Backend-internal fold. `planned_events` gains a `kind` discriminator + nullable subscription columns. The `subscriptions` route serializes merged rows back to the existing Subscription DTO, so the frontend is untouched. Behaviour is preserved by every reader filtering on `kind`. Two phases: A1 absorbs the data (this plan); A2 renames `planned_events`→`expectations` (optional, end of this plan).

**Tech Stack:** Sequelize + sequelize-cli migrations; `node:test` via `tsx` (SQLite unit/migration tests, Postgres integration tests); Express routes.

**Reference spec:** `docs/superpowers/specs/2026-05-31-cashflow-spine-folds-design.md` (Part A).

**Commands (verbatim):**
- Unit/migration tests (SQLite): `yarn test`
- Single test file: `yarn tsx --import ./test/setup.ts --test test/<path>.test.ts`
- Integration tests (Postgres): `yarn test:integration`
- Migrate / undo: `yarn db:migrate` / `yarn db:migrate:undo`
- Lint / typecheck: `yarn lint` / `yarn typecheck`

All commands run from `backend/`.

---

## Phase A1 — Absorb

### Task 1: Migration M1 — add columns + partial unique index to `planned_events`

**Files:**
- Create: `backend/src/migrations/20260531000001-expectation-absorb-columns.js`
- Test: `backend/test/migrations/expectationAbsorbMigration.test.ts`

- [ ] **Step 1: Write the failing migration test**

```typescript
// backend/test/migrations/expectationAbsorbMigration.test.ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('planned_events', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    expected_date: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'planned' },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260531000001-expectation-absorb-columns.js');
});

after(async () => { await sequelize.close(); });

test('M1 up adds kind + subscription columns with correct nullability', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('planned_events');
  assert.ok(desc.kind, 'kind exists');
  assert.equal(desc.kind.allowNull, false);
  assert.ok(desc.cadence);
  assert.equal(desc.cadence.allowNull, true);
  assert.ok(desc.normalized_name);
  assert.ok(desc.last_charge_date);
  assert.ok(desc.next_expected_date);
  assert.ok(desc.annualized_cost);
  assert.ok(desc.price_change_detected);
  assert.equal(desc.price_change_detected.allowNull, false);
  assert.ok(desc.cancellation_url);
  assert.ok(desc.category);
  assert.ok(desc.status_uncertain);
  assert.equal(desc.status_uncertain.allowNull, false);
});

test('M1 down removes the added columns', async () => {
  await migration.down(sequelize.getQueryInterface());
  const desc = await sequelize.getQueryInterface().describeTable('planned_events');
  assert.equal(desc.kind, undefined);
  assert.equal(desc.cadence, undefined);
  assert.equal(desc.status_uncertain, undefined);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `yarn tsx --import ./test/setup.ts --test test/migrations/expectationAbsorbMigration.test.ts`
Expected: FAIL — `Cannot find module '.../20260531000001-expectation-absorb-columns.js'`

- [ ] **Step 3: Write the migration**

```javascript
// backend/src/migrations/20260531000001-expectation-absorb-columns.js
'use strict';

/**
 * Expectation fold — Phase A1, M1 (spec 2026-05-31-cashflow-spine-folds-design.md).
 * Add the discriminator + subscription-absorbing columns to planned_events, plus a
 * partial unique index over (household_id, normalized_name, currency) scoped to
 * kind='subscription'. Additive + reversible — no data copy here (see M2).
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const cols = {
      kind: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'planned' },
      cadence: { type: Sequelize.STRING(16), allowNull: true },
      normalized_name: { type: Sequelize.STRING(255), allowNull: true },
      last_charge_date: { type: Sequelize.DATEONLY, allowNull: true },
      next_expected_date: { type: Sequelize.DATEONLY, allowNull: true },
      annualized_cost: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      price_change_detected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      cancellation_url: { type: Sequelize.TEXT, allowNull: true },
      category: { type: Sequelize.STRING(128), allowNull: true },
      status_uncertain: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    };
    for (const [name, def] of Object.entries(cols)) {
      await queryInterface.addColumn('planned_events', name, def);
    }
    await queryInterface.addIndex(
      'planned_events',
      ['household_id', 'normalized_name', 'currency'],
      {
        name: 'planned_events_subscription_identity_unique',
        unique: true,
        where: { kind: 'subscription' },
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'planned_events',
      'planned_events_subscription_identity_unique',
    );
    for (const name of [
      'kind', 'cadence', 'normalized_name', 'last_charge_date', 'next_expected_date',
      'annualized_cost', 'price_change_detected', 'cancellation_url', 'category',
      'status_uncertain',
    ]) {
      await queryInterface.removeColumn('planned_events', name);
    }
  },
};
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `yarn tsx --import ./test/setup.ts --test test/migrations/expectationAbsorbMigration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260531000001-expectation-absorb-columns.js backend/test/migrations/expectationAbsorbMigration.test.ts
git commit -m "feat(expectation): M1 — add subscription columns + kind to planned_events"
```

---

### Task 2: Extend the model with `kind` + subscription fields + `cancelled` status

**Files:**
- Modify: `backend/src/models/PlannedEvent.ts`
- Modify: `backend/src/models/index.ts:502-535` (Household alias → also expose `expectations`)

- [ ] **Step 1: Add the new types + `cancelled` status to `PlannedEvent.ts`**

Add `'cancelled'` to the status union + const array (currently `planned/posted/skipped/ignored`):

```typescript
export type PlannedEventStatus =
  | 'planned' | 'posted' | 'skipped' | 'ignored' | 'cancelled';

export const PLANNED_EVENT_STATUSES: readonly PlannedEventStatus[] = [
  'planned', 'posted', 'skipped', 'ignored', 'cancelled',
] as const;
```

Add the discriminator + cadence types (cadence moves here from the old `Subscription` model):

```typescript
export type ExpectationKind = 'planned' | 'subscription';
export const EXPECTATION_KINDS: readonly ExpectationKind[] = ['planned', 'subscription'] as const;

export type SubscriptionCadence =
  | 'weekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';
export const SUBSCRIPTION_CADENCES: readonly SubscriptionCadence[] = [
  'weekly', 'monthly', 'quarterly', 'semiannual', 'annual',
] as const;
```

- [ ] **Step 2: Add the field declarations to the `PlannedEvent` class**

Insert after the existing `declare notes: string | null;`:

```typescript
  declare kind: CreationOptional<ExpectationKind>;
  declare cadence: SubscriptionCadence | null;
  declare normalizedName: string | null;
  declare lastChargeDate: string | null;
  declare nextExpectedDate: string | null;
  declare annualizedCost: string | null;
  declare priceChangeDetected: CreationOptional<boolean>;
  declare cancellationUrl: string | null;
  declare category: string | null;
  declare statusUncertain: CreationOptional<boolean>;
```

- [ ] **Step 3: Add the init attributes + the partial unique index**

Insert into the `PlannedEvent.init({...})` attribute map (after `notes`):

```typescript
      kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'planned' },
      cadence: { type: DataTypes.STRING(16), allowNull: true },
      normalizedName: { type: DataTypes.STRING(255), field: 'normalized_name', allowNull: true },
      lastChargeDate: { type: DataTypes.DATEONLY, field: 'last_charge_date', allowNull: true },
      nextExpectedDate: { type: DataTypes.DATEONLY, field: 'next_expected_date', allowNull: true },
      annualizedCost: { type: DataTypes.DECIMAL(14, 4), field: 'annualized_cost', allowNull: true },
      priceChangeDetected: { type: DataTypes.BOOLEAN, field: 'price_change_detected', allowNull: false, defaultValue: false },
      cancellationUrl: { type: DataTypes.TEXT, field: 'cancellation_url', allowNull: true },
      category: { type: DataTypes.STRING(128), allowNull: true },
      statusUncertain: { type: DataTypes.BOOLEAN, field: 'status_uncertain', allowNull: false, defaultValue: false },
```

And add an `indexes` array to the init options object (the `{ sequelize, modelName, tableName: 'planned_events', underscored: true, timestamps: true }` block):

```typescript
      indexes: [
        {
          name: 'planned_events_subscription_identity_unique',
          unique: true,
          fields: ['household_id', 'normalized_name', 'currency'],
          where: { kind: 'subscription' },
        },
      ],
```

- [ ] **Step 4: Add the `expectations` association alias**

In `backend/src/models/index.ts`, after the existing PlannedEvent `Household.hasMany(..., as: 'plannedEvents')` block (`:502`), add a second alias so subscription-side code can eager-load consistently (keep the old alias too — they point at the same table):

```typescript
Household.hasMany(PlannedEvent, {
  foreignKey: 'household_id',
  as: 'expectations',
});
```

- [ ] **Step 5: Typecheck + run existing model/route tests**

Run: `yarn typecheck`
Expected: PASS (no type errors).
Run: `yarn tsx --import ./test/setup.ts --test test/plannedEvents.test.ts`
Expected: PASS (existing validator unit tests still green; if `validatePlannedEventInput` rejects the new `cancelled` status anywhere, widen its allow-list to `PLANNED_EVENT_STATUSES`).

- [ ] **Step 6: Commit**

```bash
git add backend/src/models/PlannedEvent.ts backend/src/models/index.ts
git commit -m "feat(expectation): add kind + subscription fields + cancelled status to model"
```

---

### Task 3: Subscriptions route reads/writes the merged model + serializes to the old DTO

**Files:**
- Modify: `backend/src/routes/subscriptions.ts` (the serializer, the GET/PATCH/summary handlers, and `refreshDetectedSubscriptions:170-273`)
- Create: `backend/src/expectations/subscriptionMapper.ts` (status mapping + owner lookup, shared with M2)
- Test: `backend/test/integration/subscriptionsFold.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// backend/test/integration/subscriptionsFold.test.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('subscriptions_fold');
  const mod = await import('../../src/app.js');
  app = mod.default;
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const pw = await hashPassword('password123');
  const user = await models.User.create({
    email: `sub-fold-${Date.now()}@example.com`, displayName: 'Fold',
    globalRole: 'user', passwordHash: pw.hash, passwordSalt: pw.salt, passwordParams: pw.params,
  });
  const household = await models.Household.create({ name: 'Fold household' });
  await models.HouseholdMember.create({ householdId: household.id, userId: user.id, role: 'owner' });
  householdId = household.id; userId = user.id;
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 86400000) });
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);

  // Seed a subscription as a merged Expectation row.
  await models.PlannedEvent.create({
    householdId, userId, kind: 'subscription', type: 'expense',
    source: 'recurring_detection', name: 'Netflix', normalizedName: 'netflix',
    amount: '20.0000', currency: 'CAD', cadence: 'monthly',
    expectedDate: '2026-06-15', lastChargeDate: '2026-05-15', nextExpectedDate: '2026-06-15',
    annualizedCost: '240.0000', status: 'active' === 'active' ? 'planned' : 'planned',
    category: 'Streaming', priceChangeDetected: false,
  });
});

after(async () => { await teardownPgTestDb(testDb); });

test('GET /api/subscriptions returns the merged row in the legacy DTO shape', async () => {
  const res = await agent.get('/api/subscriptions');
  assert.equal(res.status, 200);
  assert.equal(Array.isArray(res.body.items), true);
  const sub = res.body.items.find((s: { merchantName: string }) => s.merchantName === 'Netflix');
  assert.ok(sub, 'Netflix present');
  assert.equal(sub.cadence, 'monthly');
  assert.equal(sub.normalizedName, 'netflix');
  assert.equal(sub.status, 'active'); // serializer maps planned -> active for subscriptions
  assert.equal(Number(sub.amount), 20);
  assert.equal(sub.nextExpectedDate, '2026-06-15');
});

test('PATCH /api/subscriptions/:id?status=cancelled persists as cancelled', async () => {
  const list = await agent.get('/api/subscriptions');
  const id = list.body.items[0].id;
  const res = await agent.patch(`/api/subscriptions/${id}`).send({ status: 'cancelled' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `yarn test:integration` (or target the file)
Expected: FAIL — `/api/subscriptions` still queries the `subscriptions` table (empty), so Netflix isn't found.

- [ ] **Step 3: Write the mapper helpers**

```typescript
// backend/src/expectations/subscriptionMapper.ts
import type { PlannedEventStatus, SubscriptionCadence } from '../models/PlannedEvent';

/** Legacy Subscription status as exposed by /api/subscriptions. */
export type SubscriptionStatus = 'active' | 'cancelled' | 'ignored' | 'unknown';

/** Expectation status (+ uncertainty flag) -> legacy Subscription status. */
export function toSubscriptionStatus(
  status: PlannedEventStatus,
  statusUncertain: boolean,
): SubscriptionStatus {
  if (statusUncertain) return 'unknown';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'ignored') return 'ignored';
  return 'active';
}

/** Legacy Subscription status (write path) -> Expectation status + flag. */
export function fromSubscriptionStatus(
  status: SubscriptionStatus,
): { status: PlannedEventStatus; statusUncertain: boolean } {
  switch (status) {
    case 'cancelled': return { status: 'cancelled', statusUncertain: false };
    case 'ignored': return { status: 'ignored', statusUncertain: false };
    case 'unknown': return { status: 'planned', statusUncertain: true };
    case 'active': default: return { status: 'planned', statusUncertain: false };
  }
}

/** Serialize a merged Expectation row (kind='subscription') to the legacy DTO. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeSubscription(row: any) {
  return {
    id: row.id,
    householdId: row.householdId,
    merchantName: row.name,
    normalizedName: row.normalizedName,
    amount: String(row.amount),
    currency: row.currency,
    cadence: row.cadence as SubscriptionCadence,
    lastChargeDate: row.lastChargeDate,
    nextExpectedDate: row.nextExpectedDate,
    status: toSubscriptionStatus(row.status, row.statusUncertain),
    category: row.category,
    annualizedCost: String(row.annualizedCost),
    priceChangeDetected: row.priceChangeDetected,
    cancellationUrl: row.cancellationUrl,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
```

- [ ] **Step 4: Rewrite `refreshDetectedSubscriptions` to target the merged model**

Read the current function at `backend/src/routes/subscriptions.ts:170-273` and replace the `Subscription.findAll`/`create`/`update` calls. The detector + `mergeDetectionWithExisting` logic is unchanged; only persistence changes. Replace the existing-rows query and the op loop:

```typescript
  // Owner user_id for new subscription rows (Expectation requires user_id NOT NULL).
  const owner = await HouseholdMember.findOne({
    where: { householdId: args.householdId, role: 'owner' },
    attributes: ['userId'],
    raw: true,
  });
  if (!owner) throw new Error(`household ${args.householdId} has no owner member`);

  const existingRows = await PlannedEvent.findAll({
    where: { householdId: args.householdId, kind: 'subscription' },
  });
  const existing: ExistingSubscriptionRow[] = existingRows.map((row) => ({
    id: row.id,
    normalizedName: row.normalizedName ?? '',
    currency: row.currency,
    amount: String(row.amount),
    status: toSubscriptionStatus(row.status, row.statusUncertain),
    cancellationUrl: row.cancellationUrl,
    notes: row.notes,
  }));

  const ops = mergeDetectionWithExisting(detected, existing);
  for (const op of ops) {
    if (op.kind === 'insert') {
      const mapped = fromSubscriptionStatus(op.status);
      await PlannedEvent.create({
        householdId: args.householdId,
        userId: owner.userId,
        kind: 'subscription',
        type: 'expense',
        source: 'recurring_detection',
        name: op.merchantName,
        normalizedName: op.normalizedName,
        currency: op.currency,
        amount: op.amount,
        cadence: op.cadence,
        lastChargeDate: op.lastChargeDate,
        nextExpectedDate: op.nextExpectedDate,
        expectedDate: op.nextExpectedDate ?? op.lastChargeDate,
        status: mapped.status,
        statusUncertain: mapped.statusUncertain,
        category: op.category,
        annualizedCost: op.annualizedCost,
        priceChangeDetected: op.priceChangeDetected,
        cancellationUrl: null,
        notes: null,
      });
    } else {
      await PlannedEvent.update(op.patch, { where: { id: op.id, kind: 'subscription' } });
    }
  }
```

Update imports at the top of `subscriptions.ts`: remove `Subscription`, add `PlannedEvent` + `HouseholdMember` from `../models`, and `toSubscriptionStatus`, `fromSubscriptionStatus`, `serializeSubscription` from `../expectations/subscriptionMapper`. Note: `op.patch` (from `mergeDetectionWithExisting`) is keyed by legacy field names — if it sets `status`, route it through `fromSubscriptionStatus` and translate `merchantName`→`name` before the `update`. Inspect `mergeDetectionWithExisting`'s patch shape and adapt.

- [ ] **Step 5: Switch the GET/PATCH/summary handlers to the merged model + serializer**

In each `subscriptions.ts` handler, replace `Subscription.findAll(...)` with `PlannedEvent.findAll({ where: { householdId, kind: 'subscription', ... } })`, map rows through `serializeSubscription`, and for PATCH translate the inbound `status` via `fromSubscriptionStatus` before `update`. The `/summary` aggregation counts by the *legacy* status, so compute it from serialized rows (or translate the GROUP BY). Keep the response shapes identical.

- [ ] **Step 6: Run the integration test, verify it passes**

Run: `yarn test:integration`
Expected: PASS (both subscriptionsFold tests).

- [ ] **Step 7: Lint + typecheck + commit**

```bash
yarn lint && yarn typecheck
git add backend/src/routes/subscriptions.ts backend/src/expectations/subscriptionMapper.ts backend/test/integration/subscriptionsFold.test.ts
git commit -m "feat(expectation): subscriptions route reads/writes merged model via mapper"
```

---

### Task 4: Migration M2 — copy `subscriptions` rows into `planned_events`

**Files:**
- Create: `backend/src/migrations/20260531000002-expectation-absorb-data.js`
- Test: `backend/test/migrations/expectationAbsorbDataMigration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/test/migrations/expectationAbsorbDataMigration.test.ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let m1: any; let m2: any;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('planned_events', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    type: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    expected_date: { type: DataTypes.DATEONLY, allowNull: false },
    source: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'manual' },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'planned' },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('household_members', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    role: { type: DataTypes.STRING(16), allowNull: false },
  });
  await qi.createTable('subscriptions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    merchant_name: { type: DataTypes.STRING(255), allowNull: false },
    normalized_name: { type: DataTypes.STRING(255), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    cadence: { type: DataTypes.STRING(16), allowNull: false },
    last_charge_date: { type: DataTypes.DATEONLY, allowNull: false },
    next_expected_date: { type: DataTypes.DATEONLY, allowNull: true },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'active' },
    category: { type: DataTypes.STRING(128), allowNull: true },
    annualized_cost: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    price_change_detected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    cancellation_url: { type: DataTypes.TEXT, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  m1 = require('../../src/migrations/20260531000001-expectation-absorb-columns.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  m2 = require('../../src/migrations/20260531000002-expectation-absorb-data.js');
  await m1.up(qi, Sequelize);
  const now = new Date();
  await qi.bulkInsert('household_members', [{ household_id: 1, user_id: 7, role: 'owner' }]);
  await qi.bulkInsert('subscriptions', [
    { household_id: 1, merchant_name: 'Netflix', normalized_name: 'netflix', amount: '20.0000', currency: 'CAD', cadence: 'monthly', last_charge_date: '2026-05-15', next_expected_date: '2026-06-15', status: 'active', category: 'Streaming', annualized_cost: '240.0000', price_change_detected: false, cancellation_url: null, notes: null, created_at: now, updated_at: now },
    { household_id: 1, merchant_name: 'Gym', normalized_name: 'gym', amount: '50.0000', currency: 'CAD', cadence: 'monthly', last_charge_date: '2026-05-01', next_expected_date: null, status: 'unknown', category: null, annualized_cost: '600.0000', price_change_detected: false, cancellation_url: null, notes: null, created_at: now, updated_at: now },
  ]);
});

after(async () => { await sequelize.close(); });

test('M2 copies subscriptions into planned_events as kind=subscription', async () => {
  await m2.up(sequelize.getQueryInterface(), Sequelize);
  const [rows] = await sequelize.query(
    "SELECT * FROM planned_events WHERE kind='subscription' ORDER BY name",
  );
  assert.equal(rows.length, 2);
  const gym = rows.find((r: { name: string }) => r.name === 'Gym');
  const netflix = rows.find((r: { name: string }) => r.name === 'Netflix');
  // owner user_id backfilled
  assert.equal(netflix.user_id, 7);
  // expected_date falls back to last_charge_date when next_expected_date is null
  assert.equal(gym.expected_date, '2026-05-01');
  assert.equal(netflix.expected_date, '2026-06-15');
  // status mapping: active -> planned, unknown -> planned + status_uncertain
  assert.equal(netflix.status, 'planned');
  assert.equal(gym.status, 'planned');
  assert.equal(!!gym.status_uncertain, true);
  assert.equal(!!netflix.status_uncertain, false);
  assert.equal(netflix.cadence, 'monthly');
  assert.equal(netflix.type, 'expense');
  assert.equal(netflix.source, 'recurring_detection');
});

test('M2 down removes only the copied subscription rows', async () => {
  await m2.down(sequelize.getQueryInterface());
  const [rows] = await sequelize.query("SELECT * FROM planned_events WHERE kind='subscription'");
  assert.equal(rows.length, 0);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `yarn tsx --import ./test/setup.ts --test test/migrations/expectationAbsorbDataMigration.test.ts`
Expected: FAIL — M2 module not found.

- [ ] **Step 3: Write M2 (JS-side copy via `bulkInsert` for cross-dialect safety)**

```javascript
// backend/src/migrations/20260531000002-expectation-absorb-data.js
'use strict';

/**
 * Expectation fold — Phase A1, M2. Copy subscriptions -> planned_events as
 * kind='subscription'. Done in JS (not raw SQL) so Sequelize coerces booleans
 * and dates correctly on both Postgres and SQLite. Run AFTER application code is
 * deployed to read/write subscriptions through the merged model (so no writes are
 * lost). Reversible: down() deletes the copied rows.
 */
function mapStatus(s) {
  if (s === 'cancelled') return { status: 'cancelled', uncertain: false };
  if (s === 'ignored') return { status: 'ignored', uncertain: false };
  if (s === 'unknown') return { status: 'planned', uncertain: true };
  return { status: 'planned', uncertain: false }; // active + fallback
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [subs] = await queryInterface.sequelize.query('SELECT * FROM subscriptions');
    if (!subs.length) return;
    const [owners] = await queryInterface.sequelize.query(
      "SELECT household_id, user_id FROM household_members WHERE role = 'owner'",
    );
    const ownerByHousehold = new Map(owners.map((o) => [o.household_id, o.user_id]));

    const rows = subs.map((s) => {
      const ownerId = ownerByHousehold.get(s.household_id);
      if (ownerId == null) {
        throw new Error(`household ${s.household_id} has no owner member; cannot backfill user_id`);
      }
      const m = mapStatus(s.status);
      return {
        household_id: s.household_id,
        user_id: ownerId,
        kind: 'subscription',
        type: 'expense',
        source: 'recurring_detection',
        name: s.merchant_name,
        normalized_name: s.normalized_name,
        amount: s.amount,
        currency: s.currency,
        cadence: s.cadence,
        last_charge_date: s.last_charge_date,
        next_expected_date: s.next_expected_date,
        expected_date: s.next_expected_date || s.last_charge_date,
        status: m.status,
        status_uncertain: m.uncertain,
        category: s.category,
        annualized_cost: s.annualized_cost,
        price_change_detected: s.price_change_detected,
        cancellation_url: s.cancellation_url,
        notes: s.notes,
        created_at: s.created_at,
        updated_at: s.updated_at,
      };
    });
    await queryInterface.bulkInsert('planned_events', rows);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('planned_events', {
      kind: 'subscription',
      source: 'recurring_detection',
    });
  },
};
```

- [ ] **Step 4: Run, verify it passes**

Run: `yarn tsx --import ./test/setup.ts --test test/migrations/expectationAbsorbDataMigration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260531000002-expectation-absorb-data.js backend/test/migrations/expectationAbsorbDataMigration.test.ts
git commit -m "feat(expectation): M2 — copy subscriptions into planned_events"
```

---

### Task 5: Reader cutover — filter every planned reader by `kind='planned'`; move subscription readers to the merged model

**Files (modify):** `backend/src/routes/forecast.ts`, `calendar.ts`, `financialScenarios.ts`, `debt.ts`, `creditCards.ts`, `plannedEvents.ts`, `cashflow/safeToSpend.ts`, `cfo/briefingBuilder.ts`, `ai/reviewRunner.ts`, `import/rollbackImportBatch.ts` (add `kind: 'planned'`); `routes/moneyLeaks.ts`, `routes/reports.ts` (switch `Subscription.findAll` → `PlannedEvent.findAll({ where: { kind: 'subscription' } })` + `serializeSubscription`).
**Test:** `backend/test/integration/expectationKindIsolation.test.ts`

- [ ] **Step 1: Write the failing isolation test**

```typescript
// backend/test/integration/expectationKindIsolation.test.ts
// (Reuse the before()/seed harness from subscriptionsFold.test.ts: a household with
// an owner + session agent. Seed ONE kind='planned' expense and ONE kind='subscription'
// row, then assert each surfaces only where it should.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
// ... harness setup identical to subscriptionsFold.test.ts (omitted for brevity in this
// snippet — copy it; the executor should duplicate the before/after + seed) ...

test('subscription rows do NOT appear in /api/planned-events', async () => {
  const res = await agent.get('/api/planned-events');
  assert.equal(res.status, 200);
  const names = res.body.data.map((p: { name: string }) => p.name);
  assert.ok(names.includes('PlannedRent'));
  assert.ok(!names.includes('Netflix'), 'subscription leaked into planned-events');
});

test('subscription rows do NOT appear in /api/forecast', async () => {
  const res = await agent.get('/api/forecast');
  assert.equal(res.status, 200);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('Netflix'), 'subscription leaked into forecast');
});
```

(Per the No-Placeholders rule: the executor must paste the same `before`/`after` + `seed()` block used in Task 3's test, then seed `PlannedEvent.create({ ..., kind: 'planned', name: 'PlannedRent', type: 'expense', expectedDate: '2026-06-20' })` and the Netflix subscription row.)

- [ ] **Step 2: Run, verify it fails**

Run: `yarn test:integration`
Expected: FAIL — without the `kind` filter, `/api/planned-events` and `/api/forecast` include the Netflix subscription row.

- [ ] **Step 3: Add the `kind='planned'` filter to each planned reader**

Pattern — every `PlannedEvent.findAll` in the planned readers gets `kind: 'planned'` in its `where`. Example for `routes/plannedEvents.ts` list handler:

```typescript
const rows = await PlannedEvent.findAll({
  where: { householdId, kind: 'planned' /* <-- add this */, ...existingFilters },
  order: [['expectedDate', 'ASC']],
});
```

Apply the identical `kind: 'planned'` addition in: `forecast.ts`, `calendar.ts`, `financialScenarios.ts`, `debt.ts` (its own `source:'debt'` rows are already planned), `creditCards.ts`, `cashflow/safeToSpend.ts`, `cfo/briefingBuilder.ts`, `ai/reviewRunner.ts`, `import/rollbackImportBatch.ts`. (Writers in `debt.ts`/`creditCards.ts` create planned rows — set `kind: 'planned'` explicitly on `create`, or rely on the column default `'planned'`.)

- [ ] **Step 4: Move subscription readers to the merged model**

In `routes/moneyLeaks.ts` (`:140-155`) and `routes/reports.ts` (`:228`), replace `Subscription.findAll({ where: { householdId } })` with:

```typescript
const subRows = await PlannedEvent.findAll({ where: { householdId, kind: 'subscription' } });
const subscriptions = subRows.map(serializeSubscription);
```

and feed `subscriptions` into the existing leak/report logic (which already expects the legacy shape). Update imports (drop `Subscription`, add `PlannedEvent` + `serializeSubscription`).

- [ ] **Step 5: Run, verify it passes**

Run: `yarn test:integration`
Expected: PASS (isolation tests green; existing forecast/calendar/moneyLeaks integration tests still green).

- [ ] **Step 6: Lint + typecheck + commit**

```bash
yarn lint && yarn typecheck
git add backend/src/routes backend/src/cashflow backend/src/cfo backend/src/ai backend/src/import backend/test/integration/expectationKindIsolation.test.ts
git commit -m "feat(expectation): filter planned readers by kind; subscription readers use merged model"
```

---

### Task 6: Full parity verification (integration)

**Files:** Test: `backend/test/integration/expectationParity.test.ts`

- [ ] **Step 1: Write parity assertions**

Seed (via the Task 3 harness) a known fixture set, then assert response *shapes + values* are unchanged from the legacy contract:

```typescript
test('GET /api/subscriptions/summary keeps legacy totals shape', async () => {
  const res = await agent.get('/api/subscriptions/summary');
  assert.equal(res.status, 200);
  assert.ok(res.body.totals);
  assert.equal(typeof res.body.totals.active, 'number');
  assert.equal(typeof res.body.totals.cancelled, 'number');
  assert.equal(typeof res.body.totals.unknown, 'number');
  assert.ok(Array.isArray(res.body.byCurrency));
});

test('GET /api/money-leaks still returns items + totals.byCurrency', async () => {
  const res = await agent.get('/api/money-leaks');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(Array.isArray(res.body.totals.byCurrency));
});
```

- [ ] **Step 2: Run + verify pass**

Run: `yarn test:integration`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/test/integration/expectationParity.test.ts
git commit -m "test(expectation): endpoint parity coverage for the fold"
```

---

### Task 7: Migration M3 — drop `subscriptions` + delete the model

**Files:**
- Create: `backend/src/migrations/20260531000003-drop-subscriptions.js`
- Delete: `backend/src/models/Subscription.ts`
- Modify: `backend/src/models/index.ts` (remove Subscription import `:70`, init `:171`, registry `:1059`, association `:564-570`)
- Test: `backend/test/migrations/dropSubscriptionsMigration.test.ts`

- [ ] **Step 1: Pre-drop guard — re-verify no incoming FKs**

Run (from `backend/`):
```bash
grep -rn "references:.*subscriptions" src/migrations || echo "no FK references to subscriptions — safe to drop"
```
Expected: `no FK references to subscriptions — safe to drop`. If anything prints, stop and resolve before continuing.

- [ ] **Step 2: Write the failing migration test**

```typescript
// backend/test/migrations/dropSubscriptionsMigration.test.ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: any;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('subscriptions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260531000003-drop-subscriptions.js');
});
after(async () => { await sequelize.close(); });

test('up drops subscriptions; down recreates it', async () => {
  const qi = sequelize.getQueryInterface();
  await migration.up(qi, Sequelize);
  await assert.rejects(qi.describeTable('subscriptions'));
  await migration.down(qi, Sequelize);
  const desc = await qi.describeTable('subscriptions');
  assert.ok(desc.household_id);
});
```

- [ ] **Step 3: Run, verify it fails** — `yarn tsx --import ./test/setup.ts --test test/migrations/dropSubscriptionsMigration.test.ts` → module not found.

- [ ] **Step 4: Write M3** (copy the `up` body of `20260530000002-subscriptions.js` verbatim into this migration's `down`, so a rollback recreates the table + indexes):

```javascript
// backend/src/migrations/20260531000003-drop-subscriptions.js
'use strict';
/** Expectation fold — Phase A1, M3. Drop the subscriptions table now that all
 * reads/writes go through planned_events (kind='subscription'). Irreversible in
 * practice (data already lives in planned_events); down() recreates the empty
 * table shape for schema rollback only. */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.dropTable('subscriptions');
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.createTable('subscriptions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      merchant_name: { type: Sequelize.STRING(255), allowNull: false },
      normalized_name: { type: Sequelize.STRING(255), allowNull: false },
      amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      cadence: { type: Sequelize.STRING(16), allowNull: false },
      last_charge_date: { type: Sequelize.DATEONLY, allowNull: false },
      next_expected_date: { type: Sequelize.DATEONLY, allowNull: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'active' },
      category: { type: Sequelize.STRING(128), allowNull: true },
      annualized_cost: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      price_change_detected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      cancellation_url: { type: Sequelize.TEXT, allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('subscriptions', ['household_id', 'normalized_name', 'currency'], { name: 'subscriptions_household_name_currency_unique', unique: true });
    await queryInterface.addIndex('subscriptions', ['household_id', 'status'], { name: 'subscriptions_household_status' });
  },
};
```

- [ ] **Step 5: Run migration test, verify pass.**

- [ ] **Step 6: Delete the Subscription model + references**

Delete `backend/src/models/Subscription.ts`. In `backend/src/models/index.ts` remove: the import (`:70`), `initSubscription(sequelize)` (`:171`), the `Subscription,` registry entry (`:1059`), and the `Household.hasMany(Subscription...)` / `Subscription.belongsTo(...)` block (`:564-570`). Move the `SubscriptionStatus`/`SubscriptionCadence` types (now in `subscriptionMapper.ts` + `PlannedEvent.ts`) — fix any remaining imports of them from `../models/Subscription`.

- [ ] **Step 7: Full suite + typecheck**

Run: `yarn typecheck && yarn test && yarn test:integration`
Expected: PASS. Grep for stragglers: `grep -rn "from './Subscription'\|models/Subscription\|\\bSubscription\\b" backend/src | grep -v subscriptionMapper` → only legitimate hits (none referencing the deleted model).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(expectation): drop subscriptions table + delete model (fold complete)"
```

---

### Task 8: Amend the spine doc

**Files:** Modify `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md:70`

- [ ] **Step 1: Update the Expectation row + convergence note**

Change the machine in the row at `:70` from `planned → posted → skipped / ignored` to `planned → posted → skipped / ignored / cancelled`, and append to that row's note (or `:163`) that `Subscription` is folded as `kind='subscription'` with `cadence` retained as a column. Commit:

```bash
git add docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md
git commit -m "docs(spine): Expectation gains cancelled state; Subscription folded"
```

---

## Phase A2 — Rename (optional, separately shippable)

### Task 9: Rename `planned_events` → `expectations`, `PlannedEvent` → `Expectation`

**Files:**
- Create: `backend/src/migrations/20260531000004-rename-planned-events-to-expectations.js`
- Rename: `backend/src/models/PlannedEvent.ts` → `backend/src/models/Expectation.ts`
- Modify: every importer (~14 backend files; mechanical find/replace)
- Test: `backend/test/migrations/renameExpectationsMigration.test.ts`

- [ ] **Step 1: Migration test** — create `planned_events`, run `up`, assert `expectations` exists and `planned_events` does not; `down` reverses. (Mirror Task 7's test structure with `renameTable`.)

- [ ] **Step 2: Migration**

```javascript
// backend/src/migrations/20260531000004-rename-planned-events-to-expectations.js
'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) { await queryInterface.renameTable('planned_events', 'expectations'); },
  async down(queryInterface) { await queryInterface.renameTable('expectations', 'planned_events'); },
};
```

- [ ] **Step 3: Rename the model** — `git mv backend/src/models/PlannedEvent.ts backend/src/models/Expectation.ts`; rename the class `PlannedEvent`→`Expectation`, `tableName: 'planned_events'`→`'expectations'`, `modelName: 'PlannedEvent'`→`'Expectation'`, `initPlannedEvent`→`initExpectation`. Keep the type exports but consider re-exporting `PlannedEvent` as a deprecated alias for one release if external references exist.

- [ ] **Step 4: Update importers** — find/replace across backend:
```bash
grep -rln "PlannedEvent\|initPlannedEvent\|plannedEvents" backend/src
```
Update imports + usages to `Expectation`/`initExpectation`. Update the `as: 'plannedEvents'`/`as: 'expectations'` association aliases to a single `as: 'expectations'`. Endpoints + DTOs stay the same (route paths unchanged).

- [ ] **Step 5: Full suite + typecheck + commit**

```bash
yarn typecheck && yarn test && yarn test:integration
git add -A
git commit -m "refactor(expectation): rename planned_events->expectations, PlannedEvent->Expectation"
```

---

## Self-Review (run before handing off)

- **Spec coverage:** M1 columns ✓ (Task 1), model + cancelled ✓ (Task 2), serializer/route ✓ (Task 3), M2 data copy + owner backfill + expected_date fallback + status mapping ✓ (Task 4), kind-isolation of readers ✓ (Task 5), parity ✓ (Task 6), drop ✓ (Task 7), spine amendment ✓ (Task 8), rename ✓ (Task 9). MoneyLeak/dismissals untouched (correct — spec keeps them).
- **Placeholder scan:** Task 5's two test snippets explicitly instruct the executor to paste the Task 3 harness — that is a deliberate DRY pointer with the exact seed code named, not a TBD.
- **Type consistency:** `serializeSubscription`, `toSubscriptionStatus`, `fromSubscriptionStatus` defined in Task 3 and reused in Tasks 4/5/7; `ExpectationKind`/`SubscriptionCadence` defined in Task 2; status `cancelled` added in Task 2 and exercised in Tasks 3/4.

## Open items for the executor (verify, do not skip)

1. Inspect `mergeDetectionWithExisting`'s op/patch shape (`backend/src/subscriptions/detect.ts`) — Task 3 Step 4 assumes patches may carry legacy `status`/`merchantName`; translate them to `status`+`statusUncertain`/`name` before `PlannedEvent.update`.
2. Confirm Sequelize emits the partial `WHERE kind='subscription'` clause on the prod Postgres engine (inspect generated SQL or add a duplicate-insert rejection test under `test:integration`).
3. Sequence on prod: deploy Tasks 1–3+5 (code handles `kind`), run M2 (Task 4) in the same maintenance window, verify parity (Task 6), then run M3 (Task 7). Phase A2 (rename) ships separately later.
