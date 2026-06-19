# Symmetric Partner Household Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a linked partner account a first-class symmetric peer — one partner identity, viewer-relative fairness, shared-account onboarding, and effortless rule/bulk splitting.

**Architecture:** Approach A (projection layer). Link `HouseholdMember` ↔ `Contact` via a new `Contact.userId` FK; keep share storage absolute (single-payer) but project `myShare`/`partnerShare`/`balance` per viewer keyed on `Transaction.created_by_user_id`; reuse the existing `accounts.visibility='shared'` row-level guards for the partner view; add a `SplitRule` engine that feeds the existing `recomputeTransactionAmounts` with an `override > rule > auto > default` priority.

**Tech Stack:** Backend Express + Sequelize (dual-dialect SQLite/Postgres), tests via `node:test` + `tsx`. Frontend Vite + React 19 + Tailwind v4, tests via vitest. Shared DTOs in `shared/api-types.ts` (`@cashflow/shared`).

## Global Constraints

- **Dual-dialect Sequelize**: every migration and query must run on both SQLite (default) and Postgres. For `NOT NULL` adds on SQLite use the table-rebuild pattern (see `20260621000001-category-tree-foundation.js`). New nullable columns + `addIndex` work on both directly.
- **Migrations**: JS in `backend/src/migrations/`, named `YYYYMMDD...-slug.js`, with `up` and `down`. Migration *tests* live in `backend/src/migrations/__tests__/`, never directly in `src/migrations/`.
- **Colocated unit tests**: `foo.test.ts` beside `foo.ts` under `backend/src/`; auto-discovered by the runner.
- **Model pattern**: `class X extends Model<InferAttributes, InferCreationAttributes>` + `initX(sequelize)`; register `initX` in `backend/src/models/index.ts` and export the class; associations go in the association block of `index.ts`.
- **Household scoping**: every household-owned query filters through `householdWhere(req)` / `visibleTransactionWhere(req)` from `backend/src/auth/scope.ts`. Never return cross-household rows.
- **No `Co-Authored-By`** trailers on any commit. Connor is sole author.
- **Currency**: multi-currency throughout; never assume CAD.
- **Single-payer recap** (do not break): `myShareAmount` + `partnerShareAmount` = `amount` (signed portions). `partnerShareAmount` is what the non-payer owes the payer. A row is "shared" iff `partnerShareAmount !== 0` — this predicate is **viewer-independent** and must stay computed from the stored value.

---

## File Structure

**Phase 1 — Spine (partner identity)**
- `backend/src/models/Contact.ts` — add `userId` field + declaration.
- `backend/src/models/PartnerSettlement.ts` — add `recordedByUserId` field.
- `backend/src/migrations/20260618100001-contact-user-link.js` — `contacts.user_id` + partial unique index.
- `backend/src/migrations/20260618100002-settlement-recorded-by.js` — `partner_settlements.recorded_by_user_id` + owner backfill.
- `backend/src/migrations/20260618100003-backfill-partner-contact-link.js` — link sole partner-contact ↔ sole non-owner member.
- `backend/src/models/index.ts` — associations `Contact.belongsTo(User)`, `PartnerSettlement.belongsTo(User, recordedByUser)`.
- `backend/src/routes/auth.ts` — invite-accept auto-create/adopt+link Contact.
- `backend/src/household/linkPartnerContact.ts` (new) — pure helper: resolve-or-create the partner Contact for a joining member.

**Phase 2 — Projection (symmetric core)**
- `backend/src/summary/partnerFairness.ts` — `payerUserId` on `SharedTxnRow`; `viewerUserId` projection in `buildFairnessByCurrency` / `buildFairnessMonthly`; settlement `recordedByUserId` carried into `SettlementTotals`.
- `backend/src/routes/partner.ts` — SELECT `createdByUserId` + `recordedByUserId`, thread viewer + settlement attribution.

**Phase 3 — Splitting**
- `backend/src/models/SplitRule.ts` (new) — household-scoped match→action config.
- `backend/src/migrations/20260618100004-split-rules.js` — `split_rules` table.
- `backend/src/migrations/20260618100005-transaction-split-rule-id.js` — `transactions.split_rule_id`.
- `backend/src/split/applySplitRules.ts` (new) — pure: match a txn against rules → split action.
- `backend/src/import/calculateShares.ts` — extend priority to `override > rule > auto > default`.
- `backend/src/routes/splitRules.ts` (new) — CRUD + apply-over-history.
- `backend/src/routes/transactions.ts` — `POST /bulk-split`.
- `backend/src/routeRegistry.ts` — mount `splitRules`.

**Phase 4 — Frontend**
- `shared/api-types.ts` — projected fairness already typed; add `SplitRuleDto`, `BulkSplitRequest`, `PartnerHomeDto`.
- `frontend/src/pages/PartnerHomePage.tsx` (new) — viewer-relative landing.
- `frontend/src/pages/settings/sections/ShareAccountsSection.tsx` (new) — mark accounts shared.
- `frontend/src/pages/TransactionsPage` — bulk-split action.
- `frontend/src/pages/settings/tabs/SplitRulesTab.tsx` (new) — rule management.

---

## Phase 1 — Spine: one partner identity

### Task 1: `Contact.userId` column + model + association

**Files:**
- Create: `backend/src/migrations/20260618100001-contact-user-link.js`
- Modify: `backend/src/models/Contact.ts`
- Modify: `backend/src/models/index.ts` (association block + nothing new to export)
- Test: `backend/src/migrations/__tests__/contactUserLink.test.ts`

**Interfaces:**
- Produces: `Contact.userId: number | null` (DB `contacts.user_id`); partial unique index `contacts_household_user_unique` on `(household_id, user_id)` where `user_id IS NOT NULL`.

- [ ] **Step 1: Write the failing migration test**

```ts
// backend/src/migrations/__tests__/contactUserLink.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, QueryTypes } from 'sequelize';

const migration = require('../20260618100001-contact-user-link.js');

test('contact-user-link: adds nullable user_id to contacts', async () => {
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('contacts', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    household_id: { type: 'INTEGER', allowNull: false },
    name: { type: 'VARCHAR(160)', allowNull: false },
    created_at: { type: 'DATETIME', allowNull: false },
    updated_at: { type: 'DATETIME', allowNull: false },
  });
  await migration.up(qi, Sequelize);
  const cols = await sequelize.query('PRAGMA table_info(contacts)', {
    type: QueryTypes.SELECT,
  });
  assert.ok((cols as Array<{ name: string }>).some((c) => c.name === 'user_id'));
  await sequelize.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/contactUserLink.test.ts`
Expected: FAIL — `Cannot find module '../20260618100001-contact-user-link.js'`.

- [ ] **Step 3: Write the migration**

```js
// backend/src/migrations/20260618100001-contact-user-link.js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('contacts', 'user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('contacts', ['household_id', 'user_id'], {
      name: 'contacts_household_user_unique',
      unique: true,
      where: { user_id: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('contacts', 'contacts_household_user_unique');
    await queryInterface.removeColumn('contacts', 'user_id');
  },
};
```

- [ ] **Step 4: Add the model field**

In `backend/src/models/Contact.ts`, add the declaration after `householdId`:

```ts
  declare userId: CreationOptional<number | null>;
```

and the attribute in `Contact.init` after `householdId`:

```ts
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: true,
      },
```

- [ ] **Step 5: Add the association**

In `backend/src/models/index.ts`, in the association block near the other `Contact` associations (after line ~383):

```ts
User.hasMany(Contact, { foreignKey: 'user_id', as: 'linkedContacts' });
Contact.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
```

- [ ] **Step 6: Run migration test + typecheck**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/contactUserLink.test.ts && yarn workspace cashflow-backend run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add backend/src/migrations/20260618100001-contact-user-link.js backend/src/models/Contact.ts backend/src/models/index.ts backend/src/migrations/__tests__/contactUserLink.test.ts
git commit -m "feat(household): add Contact.userId link to member account"
```

---

### Task 2: Partner-contact resolver + invite-accept hook

**Files:**
- Create: `backend/src/household/linkPartnerContact.ts`
- Create: `backend/src/household/linkPartnerContact.test.ts`
- Modify: `backend/src/routes/auth.ts:126-135` (invite branch)

**Interfaces:**
- Produces: `resolveOrCreatePartnerContact(opts: { householdId: number; userId: number; displayName: string; transaction: Transaction }): Promise<Contact>` — adopts the household's single unlinked `isPartner` Contact (sets `userId`) if one exists, else creates a new `isPartner=true` Contact linked to `userId`. Never returns a Contact already linked to a *different* user.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/household/linkPartnerContact.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Contact, Household, User } from '../models';
import { resolveOrCreatePartnerContact } from './linkPartnerContact';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('adopts an existing unlinked isPartner contact', async () => {
  const hh = await Household.create({ name: 'H' });
  const u = await User.create({ email: 'p@x.io', displayName: 'Pat', globalRole: 'user', passwordHash: 'h', passwordSalt: 's', passwordParams: 'p' });
  const existing = await Contact.create({ householdId: hh.id, name: 'Pat', isPartner: true });
  const out = await sequelize.transaction((transaction) =>
    resolveOrCreatePartnerContact({ householdId: hh.id, userId: u.id, displayName: 'Pat', transaction }),
  );
  assert.equal(out.id, existing.id);
  assert.equal(out.userId, u.id);
});

test('creates a new partner contact when none exists', async () => {
  const hh = await Household.create({ name: 'H' });
  const u = await User.create({ email: 'p2@x.io', displayName: 'Sam', globalRole: 'user', passwordHash: 'h', passwordSalt: 's', passwordParams: 'p' });
  const out = await sequelize.transaction((transaction) =>
    resolveOrCreatePartnerContact({ householdId: hh.id, userId: u.id, displayName: 'Sam', transaction }),
  );
  assert.equal(out.isPartner, true);
  assert.equal(out.userId, u.id);
  assert.equal(out.name, 'Sam');
});

test('does not adopt a contact already linked to another user', async () => {
  const hh = await Household.create({ name: 'H' });
  const other = await User.create({ email: 'o@x.io', displayName: 'O', globalRole: 'user', passwordHash: 'h', passwordSalt: 's', passwordParams: 'p' });
  const u = await User.create({ email: 'p3@x.io', displayName: 'New', globalRole: 'user', passwordHash: 'h', passwordSalt: 's', passwordParams: 'p' });
  await Contact.create({ householdId: hh.id, name: 'Taken', isPartner: true, userId: other.id });
  const out = await sequelize.transaction((transaction) =>
    resolveOrCreatePartnerContact({ householdId: hh.id, userId: u.id, displayName: 'New', transaction }),
  );
  assert.equal(out.userId, u.id);
  assert.notEqual(out.name, 'Taken');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/household/linkPartnerContact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

```ts
// backend/src/household/linkPartnerContact.ts
import type { Transaction } from 'sequelize';
import { Contact } from '../models';

/**
 * Resolve the Contact that represents a household member for fairness/splits.
 * Adopts the household's single unlinked is_partner Contact when present
 * (so the pre-existing "partner" row gets wired to the new login), otherwise
 * creates a fresh is_partner Contact linked to the user. A contact already
 * linked to a different user is never adopted.
 */
export async function resolveOrCreatePartnerContact(opts: {
  householdId: number;
  userId: number;
  displayName: string;
  transaction: Transaction;
}): Promise<Contact> {
  const { householdId, userId, displayName, transaction } = opts;

  const existing = await Contact.findOne({
    where: { householdId, isPartner: true, userId: null },
    order: [['id', 'ASC']],
    transaction,
  });
  if (existing) {
    await existing.update({ userId }, { transaction });
    return existing;
  }
  return Contact.create(
    { householdId, userId, name: displayName, isPartner: true },
    { transaction },
  );
}
```

- [ ] **Step 4: Wire it into invite-accept**

In `backend/src/routes/auth.ts`, import at the top with the other local imports:

```ts
import { resolveOrCreatePartnerContact } from '../household/linkPartnerContact';
```

Inside the `if (invite) { ... }` branch (after `invite.update(...)`, before the branch closes, ~line 135):

```ts
        await resolveOrCreatePartnerContact({
          householdId: household.id,
          userId: createdUser.id,
          displayName,
          transaction: t,
        });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/household/linkPartnerContact.test.ts && yarn workspace cashflow-backend run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/household/linkPartnerContact.ts backend/src/household/linkPartnerContact.test.ts backend/src/routes/auth.ts
git commit -m "feat(household): link partner contact to member on invite accept"
```

---

### Task 3: Backfill migration — link existing partner contact ↔ member

**Files:**
- Create: `backend/src/migrations/20260618100003-backfill-partner-contact-link.js`
- Test: `backend/src/migrations/__tests__/backfillPartnerContactLink.test.ts`

**Interfaces:**
- Produces: for every household with exactly one `is_partner=true` contact whose `user_id IS NULL` AND exactly one non-owner member, sets that contact's `user_id` to that member's `user_id`. Ambiguous households are left untouched.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/migrations/__tests__/backfillPartnerContactLink.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, QueryTypes } from 'sequelize';

const migration = require('../20260618100003-backfill-partner-contact-link.js');

async function seed(qi: ReturnType<Sequelize['getQueryInterface']>) {
  await qi.bulkInsert('household_members', [
    { household_id: 1, user_id: 10, role: 'owner', created_at: new Date(), updated_at: new Date() },
    { household_id: 1, user_id: 11, role: 'member', created_at: new Date(), updated_at: new Date() },
    // household 2: two non-owner members -> ambiguous, must be skipped
    { household_id: 2, user_id: 20, role: 'owner', created_at: new Date(), updated_at: new Date() },
    { household_id: 2, user_id: 21, role: 'member', created_at: new Date(), updated_at: new Date() },
    { household_id: 2, user_id: 22, role: 'member', created_at: new Date(), updated_at: new Date() },
  ]);
  await qi.bulkInsert('contacts', [
    { id: 1, household_id: 1, name: 'Alex', is_partner: 1, user_id: null, created_at: new Date(), updated_at: new Date() },
    { id: 2, household_id: 2, name: 'X', is_partner: 1, user_id: null, created_at: new Date(), updated_at: new Date() },
  ]);
}

test('backfill links sole partner-contact to sole non-owner member', async () => {
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('household_members', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    household_id: 'INTEGER', user_id: 'INTEGER', role: 'VARCHAR(32)',
    created_at: 'DATETIME', updated_at: 'DATETIME',
  });
  await qi.createTable('contacts', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    household_id: 'INTEGER', name: 'VARCHAR(160)', is_partner: 'BOOLEAN', user_id: 'INTEGER',
    created_at: 'DATETIME', updated_at: 'DATETIME',
  });
  await seed(qi);
  await migration.up(qi, Sequelize);
  const rows = await sequelize.query('SELECT id, user_id FROM contacts ORDER BY id', { type: QueryTypes.SELECT });
  assert.equal((rows as Array<{ id: number; user_id: number | null }>)[0].user_id, 11);
  assert.equal((rows as Array<{ id: number; user_id: number | null }>)[1].user_id, null); // household 2 ambiguous
  await sequelize.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/backfillPartnerContactLink.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the migration**

```js
// backend/src/migrations/20260618100003-backfill-partner-contact-link.js
'use strict';

module.exports = {
  async up(queryInterface) {
    const sql = `
      SELECT c.id AS contact_id, m.user_id AS user_id
      FROM contacts c
      JOIN (
        SELECT household_id, COUNT(*) AS member_count, MIN(user_id) AS user_id
        FROM household_members
        WHERE role <> 'owner'
        GROUP BY household_id
        HAVING COUNT(*) = 1
      ) m ON m.household_id = c.household_id
      WHERE c.is_partner = true AND c.user_id IS NULL
      AND (
        SELECT COUNT(*) FROM contacts c2
        WHERE c2.household_id = c.household_id AND c2.is_partner = true AND c2.user_id IS NULL
      ) = 1
    `;
    const [rows] = await queryInterface.sequelize.query(sql);
    for (const row of rows) {
      await queryInterface.sequelize.query(
        'UPDATE contacts SET user_id = :userId WHERE id = :contactId',
        { replacements: { userId: row.user_id, contactId: row.contact_id } },
      );
    }
  },

  async down() {
    // No-op: backfill is not reversible (we cannot tell which links were backfilled
    // vs set by the invite-accept hook). Safe to leave links in place.
  },
};
```

> Note on `is_partner = true`: SQLite stores booleans as 0/1 but accepts `true`
> in comparisons; Postgres uses native booleans. Both evaluate this predicate
> correctly. The test seeds `is_partner: 1`.

- [ ] **Step 4: Run test + typecheck**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/backfillPartnerContactLink.test.ts && yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260618100003-backfill-partner-contact-link.js backend/src/migrations/__tests__/backfillPartnerContactLink.test.ts
git commit -m "feat(household): backfill partner contact <-> member link"
```

---

### Task 4: `PartnerSettlement.recordedByUserId`

**Files:**
- Create: `backend/src/migrations/20260618100002-settlement-recorded-by.js`
- Modify: `backend/src/models/PartnerSettlement.ts`
- Modify: `backend/src/models/index.ts` (association)
- Modify: `backend/src/routes/settlements.ts` (set `recordedByUserId` on create)
- Test: `backend/src/migrations/__tests__/settlementRecordedBy.test.ts`

**Interfaces:**
- Produces: `PartnerSettlement.recordedByUserId: number | null` (DB `recorded_by_user_id`). On backfill, set to the household's `owner` member's `user_id`. New settlements record the authed user's id.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/migrations/__tests__/settlementRecordedBy.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, QueryTypes } from 'sequelize';

const migration = require('../20260618100002-settlement-recorded-by.js');

test('settlement-recorded-by: adds column and backfills owner', async () => {
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('household_members', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    household_id: 'INTEGER', user_id: 'INTEGER', role: 'VARCHAR(32)',
    created_at: 'DATETIME', updated_at: 'DATETIME',
  });
  await qi.createTable('partner_settlements', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    household_id: 'INTEGER', contact_id: 'INTEGER', direction: 'VARCHAR(32)',
    currency: 'VARCHAR(3)', amount: 'DECIMAL(14,4)', settled_date: 'DATE',
    created_at: 'DATETIME', updated_at: 'DATETIME',
  });
  await qi.bulkInsert('household_members', [
    { household_id: 5, user_id: 99, role: 'owner', created_at: new Date(), updated_at: new Date() },
  ]);
  await qi.bulkInsert('partner_settlements', [
    { household_id: 5, contact_id: 1, direction: 'i_paid_partner', currency: 'CAD', amount: '10.0', settled_date: '2026-05-01', created_at: new Date(), updated_at: new Date() },
  ]);
  await migration.up(qi, Sequelize);
  const rows = await sequelize.query('SELECT recorded_by_user_id FROM partner_settlements', { type: QueryTypes.SELECT });
  assert.equal((rows as Array<{ recorded_by_user_id: number | null }>)[0].recorded_by_user_id, 99);
  await sequelize.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/settlementRecordedBy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the migration**

```js
// backend/src/migrations/20260618100002-settlement-recorded-by.js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('partner_settlements', 'recorded_by_user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
    });
    // Backfill: attribute legacy settlements to the household owner ("me" today).
    await queryInterface.sequelize.query(`
      UPDATE partner_settlements
      SET recorded_by_user_id = (
        SELECT m.user_id FROM household_members m
        WHERE m.household_id = partner_settlements.household_id AND m.role = 'owner'
        ORDER BY m.id ASC LIMIT 1
      )
      WHERE recorded_by_user_id IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('partner_settlements', 'recorded_by_user_id');
  },
};
```

- [ ] **Step 4: Add the model field**

In `backend/src/models/PartnerSettlement.ts`, add declaration after `householdId`:

```ts
  declare recordedByUserId: CreationOptional<number | null>;
```

and the attribute in `init` after `householdId`:

```ts
      recordedByUserId: {
        type: DataTypes.INTEGER,
        field: 'recorded_by_user_id',
        allowNull: true,
      },
```

- [ ] **Step 5: Add the association + record on create**

In `backend/src/models/index.ts`, near the `PartnerSettlement` associations (~line 391):

```ts
User.hasMany(PartnerSettlement, { foreignKey: 'recorded_by_user_id', as: 'recordedSettlements' });
PartnerSettlement.belongsTo(User, { foreignKey: 'recorded_by_user_id', as: 'recordedByUser' });
```

In `backend/src/routes/settlements.ts`, the `POST` handler that calls `PartnerSettlement.create({...})` — add `recordedByUserId` from the authed user. Find the create call and add:

```ts
      recordedByUserId: currentAuth(req).user.id,
```

(`currentAuth` is already imported in that file.)

- [ ] **Step 6: Run tests + typecheck**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/settlementRecordedBy.test.ts && yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/migrations/20260618100002-settlement-recorded-by.js backend/src/models/PartnerSettlement.ts backend/src/models/index.ts backend/src/routes/settlements.ts backend/src/migrations/__tests__/settlementRecordedBy.test.ts
git commit -m "feat(household): attribute partner settlements to recording user"
```

---

## Phase 2 — Viewer-relative projection

### Task 5: Carry `payerUserId` into `SharedTxnRow`

**Files:**
- Modify: `backend/src/summary/partnerFairness.ts` (`SharedTxnRow` type)
- Modify: `backend/src/routes/partner.ts` (`RawTxnRow`, SELECT attributes, row map)

**Interfaces:**
- Produces: `SharedTxnRow.payerUserId: number | null` — `transactions.created_by_user_id`.

- [ ] **Step 1: Extend the type**

In `backend/src/summary/partnerFairness.ts`, add to the `SharedTxnRow` type (after `counterpartyContactId`):

```ts
  /** transactions.created_by_user_id — the payer in the single-payer model. Drives viewer-relative projection. NULL on legacy rows. */
  payerUserId: number | null;
```

- [ ] **Step 2: Thread it through the loader**

In `backend/src/routes/partner.ts`:
- Add `createdByUserId: number | null;` to the `RawTxnRow` type.
- Add `'createdByUserId'` to the `attributes` array in the `Transaction.findAll` call.
- Add `payerUserId: r.createdByUserId,` to the `sharedRows` map object.

- [ ] **Step 3: Update the test row factory**

In `backend/src/summary/partnerFairness.test.ts`, add `payerUserId: null,` to the `makeRow` defaults object (after `contactName: null,`).

- [ ] **Step 4: Run the existing fairness suite + typecheck**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts && yarn workspace cashflow-backend run typecheck`
Expected: PASS — no behavior change yet, just the new field.

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/partnerFairness.ts backend/src/routes/partner.ts backend/src/summary/partnerFairness.test.ts
git commit -m "feat(partner): carry payerUserId into SharedTxnRow"
```

---

### Task 6: Viewer-relative projection in `buildFairnessByCurrency`

This is the load-bearing task. The projection has two independent transforms:
1. **Display swap** (consumption portions): `myShare`/`partnerShare` swap when the viewer is not the payer.
2. **Balance** from the verified contribution formula — NOT from swapped totals.

Sharedness (`partnerShare !== 0`) is computed from the **stored** value before any swap.

**Files:**
- Modify: `backend/src/summary/partnerFairness.ts`
- Test: `backend/src/summary/partnerFairness.test.ts`

**Interfaces:**
- Produces: `buildFairnessByCurrency(rows, settlements, currentMonthStart, nextMonthStart, options)` where `FairnessOptions` gains `viewerUserId?: number | null`. When `viewerUserId` is null/undefined, behavior is identical to today (owner POV). `SettlementTotals` is assumed already viewer-projected by the caller (Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// add to backend/src/summary/partnerFairness.test.ts

test('buildFairnessByCurrency: viewer projection mirrors balance between partners', () => {
  // Connor (user 1) paid a shared $100 grocery; partner owes 50 (stored negative).
  const rows: SharedTxnRow[] = [
    makeRow({ txnId: 1, amount: -100, myShare: -50, partnerShare: -50, payerUserId: 1 }),
  ];
  const owner = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01', { viewerUserId: 1 });
  const partner = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01', { viewerUserId: 2 });
  // Owner: partner owes me 50.
  assert.equal(Math.round(owner[0].balance * 100) / 100, 50);
  assert.equal(owner[0].direction, 'partner_owes_me');
  // Partner: I owe 50 — exact mirror.
  assert.equal(Math.round(partner[0].balance * 100) / 100, -50);
  assert.equal(partner[0].direction, 'i_owe_partner');
});

test('buildFairnessByCurrency: viewer projection swaps consumption display', () => {
  const rows: SharedTxnRow[] = [
    makeRow({ txnId: 1, amount: -100, myShare: -70, partnerShare: -30, payerUserId: 1, category: 'Dining' }),
  ];
  const owner = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01', { viewerUserId: 1 });
  const partner = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01', { viewerUserId: 2 });
  // Owner consumed 70, partner consumed 30.
  assert.equal(owner[0].myShareTotal, -70);
  assert.equal(owner[0].partnerShareTotal, -30);
  // Partner's POV: their own consumption is 30, the other's is 70.
  assert.equal(partner[0].myShareTotal, -30);
  assert.equal(partner[0].partnerShareTotal, -70);
});

test('buildFairnessByCurrency: a me-only row is shared for neither viewer', () => {
  // partnerShare 0 => not a shared expense; must not surface even for the non-payer.
  const rows: SharedTxnRow[] = [
    makeRow({ txnId: 1, amount: -100, myShare: -100, partnerShare: 0, payerUserId: 1 }),
  ];
  const partner = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01', { viewerUserId: 2 });
  assert.equal(partner.length, 0);
});

test('buildFairnessByCurrency: no viewerUserId behaves as owner POV (back-compat)', () => {
  const rows: SharedTxnRow[] = [
    makeRow({ txnId: 1, amount: -100, myShare: -50, partnerShare: -50, payerUserId: 1 }),
  ];
  const legacy = buildFairnessByCurrency(rows, [], '2026-05-01', '2026-06-01');
  assert.equal(Math.round(legacy[0].balance * 100) / 100, 50);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts --test-name-pattern 'viewer projection|me-only row|owner POV'`
Expected: FAIL on the mirror/swap assertions (current code ignores `viewerUserId`).

- [ ] **Step 3: Implement the projection**

In `backend/src/summary/partnerFairness.ts`:

Add `viewerUserId` to `FairnessOptions`:

```ts
export type FairnessOptions = {
  partnerContactIds?: Set<number>;
  excludeNonPartnerInflows?: boolean;
  /**
   * When set, project shares relative to this user: a row's consumption
   * display swaps when viewerUserId !== payerUserId, and balance uses the
   * per-row contribution `(payer==viewer ? -partnerShare : +partnerShare)`.
   * When null/undefined, behaves as owner POV (legacy: me = payer).
   */
  viewerUserId?: number | null;
};
```

Add a pure projection helper above `buildFairnessByCurrency`:

```ts
/**
 * Project a stored (owner-POV) row to the viewer's perspective.
 * - `shared` is computed from the STORED partnerShare (viewer-independent):
 *   a row is shared iff the non-payer owes a non-zero amount.
 * - `myShare`/`partnerShare` are consumption portions, swapped when the
 *   viewer is not the payer.
 * - `balanceContribution` is the signed receivable for the viewer:
 *   payer is owed `partnerShare`; the non-payer owes it. Spend is stored
 *   negative, so `-partnerShare` yields the positive "owed to me" figure.
 */
function projectRow(
  row: SharedTxnRow,
  viewerUserId: number | null | undefined,
): { shared: boolean; myShare: number; partnerShare: number; balanceContribution: number } {
  const shared = row.partnerShare !== 0;
  const isPayer = viewerUserId == null || row.payerUserId == null || row.payerUserId === viewerUserId;
  return {
    shared,
    myShare: isPayer ? row.myShare : row.partnerShare,
    partnerShare: isPayer ? row.partnerShare : row.myShare,
    balanceContribution: isPayer ? -row.partnerShare : row.partnerShare,
  };
}
```

Rework the per-currency loop in `buildFairnessByCurrency`. Replace the bucketing block (the loop starting `for (const r of rows) { if (r.partnerShare === 0) continue; ...`) and the per-currency totals so that:
- the shared filter uses `projectRow(r, viewerUserId).shared`;
- buckets store the **projected** row (with swapped `myShare`/`partnerShare`) so `categoryBreakdown`, `largestShared`, `myShareTotal`, `partnerShareTotal`, `currentMonthSharedSpend` all read the viewer's display values;
- `balance` accumulates `balanceContribution` across rows instead of `-partnerShareTotal`.

Concretely, change the row-bucketing loop:

```ts
  const viewerUserId = options.viewerUserId;
  const rowsByCurrency = new Map<string, SharedTxnRow[]>();
  for (const r of rows) {
    const p = projectRow(r, viewerUserId);
    if (!p.shared) continue;
    if (excludeNonPartnerInflows) {
      const kind = classifyInflow(r, partnerContactIds);
      if (kind === 'non_partner') continue;
    }
    const list = rowsByCurrency.get(r.currency) ?? [];
    // Push the projected row so all downstream display reads the viewer's values.
    list.push({ ...r, myShare: p.myShare, partnerShare: p.partnerShare });
    rowsByCurrency.set(r.currency, list);
  }
```

Then inside the `for (const currency of allCurrencies)` block, compute `balance` from the contribution rather than `-partnerShareTotal`. Replace:

```ts
    const balance = -partnerShareTotal + (settlement.iPaid - settlement.partnerPaid);
```

with a balance accumulated over the (projected) list — note that for the projected list, `partnerShare` is already the viewer's "other person consumption", which is NOT the receivable. So accumulate the contribution explicitly from the projected `partnerShare` only when the viewer is the payer. Simplest correct form: recompute from the original rows is unnecessary — for a projected row, `balanceContribution = -(viewer-receivable)`. Since we already pushed projected rows, store the contribution alongside. Change the push to also stash it:

Replace the push line above with pushing an augmented row, and extend the local type via a parallel array. Use a parallel `Map<string, number[]>` keyed by currency for contributions:

```ts
  const contributionsByCurrency = new Map<string, number>();
  // ...in the bucketing loop, after rowsByCurrency.set(...):
    contributionsByCurrency.set(
      r.currency,
      (contributionsByCurrency.get(r.currency) ?? 0) + p.balanceContribution,
    );
```

and in the per-currency block:

```ts
    const rowsContribution = contributionsByCurrency.get(currency) ?? 0;
    const balance = rowsContribution + (settlement.iPaid - settlement.partnerPaid);
```

Leave `sharedSpendTotal`, `myShareTotal`, `partnerShareTotal`, `currentMonthSharedSpend` summing over the projected `list` exactly as today (they now reflect the viewer).

- [ ] **Step 4: Run the full fairness suite**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: PASS — new viewer tests pass, all existing tests (which pass `payerUserId: null` / no `viewerUserId`) still pass because the legacy path computes `balanceContribution = -partnerShare`, identical to `-partnerShareTotal`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/partnerFairness.ts backend/src/summary/partnerFairness.test.ts
git commit -m "feat(partner): viewer-relative fairness projection"
```

---

### Task 7: Viewer-relative `buildFairnessMonthly`

**Files:**
- Modify: `backend/src/summary/partnerFairness.ts` (`buildFairnessMonthly`)
- Test: `backend/src/summary/partnerFairness.test.ts`

**Interfaces:**
- Consumes: `projectRow` from Task 6, `FairnessOptions.viewerUserId`.
- Produces: `buildFairnessMonthly` projects per viewer using the same `projectRow`; `netDelta` uses the balance contribution.

- [ ] **Step 1: Write the failing test**

```ts
// add to backend/src/summary/partnerFairness.test.ts
test('buildFairnessMonthly: viewer projection mirrors netDelta', () => {
  const rows: SharedTxnRow[] = [
    makeRow({ txnId: 1, date: '2026-05-10', amount: -100, myShare: -50, partnerShare: -50, payerUserId: 1 }),
  ];
  const owner = buildFairnessMonthly(rows, [], { viewerUserId: 1 });
  const partner = buildFairnessMonthly(rows, [], { viewerUserId: 2 });
  assert.equal(Math.round(owner[0].netDelta * 100) / 100, 50);
  assert.equal(Math.round(partner[0].netDelta * 100) / 100, -50);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts --test-name-pattern 'Monthly: viewer'`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `buildFairnessMonthly`, read `const viewerUserId = options.viewerUserId;`. In the row loop, replace the `if (r.partnerShare === 0) continue;` + share accumulation with the projection:

```ts
  for (const r of rows) {
    const p = projectRow(r, viewerUserId);
    if (!p.shared) continue;
    if (excludeNonPartnerInflows) {
      const kind = classifyInflow(r, partnerContactIds);
      if (kind === 'non_partner') continue;
    }
    const month = r.date.slice(0, 7);
    const key = `${r.currency}\0${month}`;
    const acc = byKey.get(key) ?? ({ sharedSpend: 0, myShare: 0, partnerShare: 0, settlementDelta: 0, contribution: 0 } satisfies Acc);
    acc.sharedSpend += r.amount;
    acc.myShare += p.myShare;
    acc.partnerShare += p.partnerShare;
    acc.contribution += p.balanceContribution;
    byKey.set(key, acc);
  }
```

Add `contribution: number` to the `Acc` type, initialize it `0` in the settlements loop's default too, and change `netDelta`:

```ts
    const netDelta = acc.contribution + acc.settlementDelta;
```

(Legacy path: `contribution` sums `-partnerShare`, identical to the old `-acc.partnerShare`.)

- [ ] **Step 4: Run the suite**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/partnerFairness.ts backend/src/summary/partnerFairness.test.ts
git commit -m "feat(partner): viewer-relative monthly fairness trend"
```

---

### Task 8: Settlement direction projection + wire viewer into routes

**Files:**
- Modify: `backend/src/routes/partner.ts` (`RawSettlementRow`, SELECT, rollup, viewer threading)
- Test: `backend/test/integration/partnerProjection.test.ts` (integration — needs Postgres/auth)

**Interfaces:**
- Consumes: `recordedByUserId` (Task 4), `viewerUserId` option (Tasks 6/7).
- Produces: `loadSharedTxns(req)` selects `createdByUserId` and `recordedByUserId`; settlement rollup swaps `iPaid ↔ partnerPaid` when `recordedByUserId !== viewerUserId`. The three GET routes pass `viewerUserId: currentAuth(req).user.id`.

- [ ] **Step 1: Implement settlement projection in the loader**

In `backend/src/routes/partner.ts`:
- Add `recordedByUserId: number | null;` to `RawSettlementRow`.
- Add `'recordedByUserId'` to the `PartnerSettlement.findAll` `attributes`.
- Resolve the viewer once at the top of `loadSharedTxns`:

```ts
  let viewerUserId: number | null = null;
  try {
    viewerUserId = currentAuth(req).user.id;
  } catch {
    viewerUserId = null; // tests bypassing auth
  }
```

- In the settlement rollup loop, project direction per viewer before bucketing:

```ts
  for (const s of settlements as unknown as RawSettlementRow[]) {
    const amount = num(s.amount) ?? 0;
    // Project direction: when the viewer is NOT the user who recorded the
    // settlement, "i_paid_partner" reads as "partner_paid_me" and vice-versa.
    const flip = viewerUserId != null && s.recordedByUserId != null && s.recordedByUserId !== viewerUserId;
    const iPaidDelta = s.direction === 'i_paid_partner' ? amount : 0;
    const partnerPaidDelta = s.direction === 'partner_paid_me' ? amount : 0;
    const iPaid = flip ? partnerPaidDelta : iPaidDelta;
    const partnerPaid = flip ? iPaidDelta : partnerPaidDelta;
    // ...accumulate iPaid/partnerPaid into totalsByKey and monthlyByKey
  }
```

Rewrite the existing `if (s.direction === 'i_paid_partner') existing.iPaid += amount; else existing.partnerPaid += amount;` (and the monthly equivalent) to add `iPaid`/`partnerPaid` computed above.

- Return `viewerUserId` from `loadSharedTxns` (add to the return object + the function's return type).

- [ ] **Step 2: Pass viewer into the builders**

In all three routes (`/fairness`, `/monthly`, `/settlement-recommendation`), destructure `viewerUserId` from `loadSharedTxns(req)` and add `viewerUserId` to the `options` object passed to `buildFairnessByCurrency` / `buildFairnessMonthly`.

- [ ] **Step 3: Write an integration test**

```ts
// backend/test/integration/partnerProjection.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerAndLogin, seedSharedTxn } from './helpers'; // use existing integration helpers
// NOTE: follow the pattern in the nearest existing backend/test/integration/*.test.ts
// for app/agent/auth setup. The assertion that matters:

test('GET /api/partner/fairness mirrors balance for owner vs partner', async () => {
  // owner imports a shared $100 txn (partner owes 50); partner logs in via invite.
  // owner sees balance +50 (partner_owes_me); partner sees -50 (i_owe_partner).
  // Assert both via two authed agents hitting /api/partner/fairness.
});
```

> The worker should mirror the auth/seed helpers used by the closest existing
> integration test (e.g. `backend/test/integration/*.test.ts`). The behavioral
> assertion: owner `byCurrency[0].balance > 0` and partner `byCurrency[0].balance < 0`
> with equal magnitude.

- [ ] **Step 4: Run integration test + typecheck**

Run: `cd backend && TEST_DATABASE_URL=$TEST_DATABASE_URL yarn workspace cashflow-backend run test:integration 2>&1 | tail -20 && yarn workspace cashflow-backend run typecheck`
Expected: PASS (requires Postgres + `TEST_DATABASE_URL`).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/partner.ts backend/test/integration/partnerProjection.test.ts
git commit -m "feat(partner): project settlement direction + wire viewer through fairness routes"
```

---

## Phase 3 — Effortless splitting

### Task 9: `SplitRule` model + table

**Files:**
- Create: `backend/src/models/SplitRule.ts`
- Create: `backend/src/migrations/20260618100004-split-rules.js`
- Modify: `backend/src/models/index.ts` (register init, export, associations)
- Test: `backend/src/migrations/__tests__/splitRules.test.ts`

**Interfaces:**
- Produces: `SplitRule` with fields `id`, `householdId`, `name`, `matchCategory: string | null`, `matchMerchant: string | null`, `matchAccountId: number | null`, `minAmountAbs: string | null` (DECIMAL, compared against `|amount|`), `splitType: 'me'|'partner'|'shared'`, `pctMe: string | null`, `pctPartner: string | null`, `priority: number` (lower = applied first), `enabled: boolean`.

- [ ] **Step 1: Write the failing migration test**

```ts
// backend/src/migrations/__tests__/splitRules.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, QueryTypes } from 'sequelize';
const migration = require('../20260618100004-split-rules.js');

test('split-rules: creates table with expected columns', async () => {
  const sequelize = new Sequelize('sqlite::memory:', { logging: false });
  const qi = sequelize.getQueryInterface();
  await migration.up(qi, Sequelize);
  const cols = await sequelize.query('PRAGMA table_info(split_rules)', { type: QueryTypes.SELECT });
  const names = (cols as Array<{ name: string }>).map((c) => c.name);
  for (const n of ['household_id', 'name', 'match_category', 'match_merchant', 'match_account_id', 'min_amount_abs', 'split_type', 'pct_me', 'pct_partner', 'priority', 'enabled']) {
    assert.ok(names.includes(n), `missing column ${n}`);
  }
  await sequelize.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/splitRules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the migration**

```js
// backend/src/migrations/20260618100004-split-rules.js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('split_rules', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      name: { type: Sequelize.STRING(160), allowNull: false },
      match_category: { type: Sequelize.STRING(128), allowNull: true },
      match_merchant: { type: Sequelize.STRING(160), allowNull: true },
      match_account_id: { type: Sequelize.INTEGER, allowNull: true },
      min_amount_abs: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      split_type: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'shared' },
      pct_me: { type: Sequelize.DECIMAL(6, 4), allowNull: true },
      pct_partner: { type: Sequelize.DECIMAL(6, 4), allowNull: true },
      priority: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 100 },
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('split_rules', ['household_id', 'priority'], {
      name: 'split_rules_household_priority',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('split_rules');
  },
};
```

- [ ] **Step 4: Write the model**

```ts
// backend/src/models/SplitRule.ts
import {
  Model, DataTypes, type Sequelize, type ModelAttributes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';

export type SplitRuleType = 'me' | 'partner' | 'shared';

export class SplitRule extends Model<
  InferAttributes<SplitRule>,
  InferCreationAttributes<SplitRule>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare name: string;
  declare matchCategory: string | null;
  declare matchMerchant: string | null;
  declare matchAccountId: number | null;
  declare minAmountAbs: string | null;
  declare splitType: SplitRuleType;
  declare pctMe: string | null;
  declare pctPartner: string | null;
  declare priority: CreationOptional<number>;
  declare enabled: CreationOptional<boolean>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSplitRule(sequelize: Sequelize): typeof SplitRule {
  SplitRule.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      name: { type: DataTypes.STRING(160), allowNull: false },
      matchCategory: { type: DataTypes.STRING(128), field: 'match_category', allowNull: true },
      matchMerchant: { type: DataTypes.STRING(160), field: 'match_merchant', allowNull: true },
      matchAccountId: { type: DataTypes.INTEGER, field: 'match_account_id', allowNull: true },
      minAmountAbs: { type: DataTypes.DECIMAL(14, 4), field: 'min_amount_abs', allowNull: true },
      splitType: { type: DataTypes.STRING(16), field: 'split_type', allowNull: false, defaultValue: 'shared' },
      pctMe: { type: DataTypes.DECIMAL(6, 4), field: 'pct_me', allowNull: true },
      pctPartner: { type: DataTypes.DECIMAL(6, 4), field: 'pct_partner', allowNull: true },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    } as ModelAttributes<SplitRule>,
    { sequelize, modelName: 'SplitRule', tableName: 'split_rules', underscored: true, timestamps: true },
  );
  return SplitRule;
}
```

- [ ] **Step 5: Register + associate + export**

In `backend/src/models/index.ts`:
- import: `import { SplitRule, initSplitRule } from './SplitRule';`
- init (near `initRule(sequelize);`): `initSplitRule(sequelize);`
- association block:
  ```ts
  Household.hasMany(SplitRule, { foreignKey: 'household_id', as: 'splitRules', onDelete: 'CASCADE', hooks: true });
  SplitRule.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
  ```
- add `SplitRule,` to the `export { ... }` block.

- [ ] **Step 6: Run test + typecheck**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/splitRules.test.ts && yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/models/SplitRule.ts backend/src/migrations/20260618100004-split-rules.js backend/src/models/index.ts backend/src/migrations/__tests__/splitRules.test.ts
git commit -m "feat(split): add SplitRule model + table"
```

---

### Task 10: Split-rule matcher + `splitRuleId` provenance in recompute

**Files:**
- Create: `backend/src/split/applySplitRules.ts`
- Create: `backend/src/split/applySplitRules.test.ts`
- Create: `backend/src/migrations/20260618100005-transaction-split-rule-id.js`
- Modify: `backend/src/models/Transaction.ts` (declare `splitRuleId`)
- Modify: `backend/src/import/calculateShares.ts` (priority: override > rule > auto > default)
- Test: `backend/src/import/calculateShares.test.ts` (extend if present, else create)

**Interfaces:**
- Produces: `matchSplitRule(txn: { finalCategory?: string|null; merchantClean?: string|null; merchantRaw?: string; accountId?: number|null; amount: number|string }, rules: SplitRuleLike[]): SplitRuleLike | null` — returns the lowest-`priority` enabled rule whose every set criterion matches, else null.
- Produces: `recomputeTransactionAmounts` honours a `ruleSplitType`/`rulePctMe`/`rulePctPartner` tier between override and auto. The route layer (Task 11/12) is responsible for writing `splitRuleId` + the rule-derived `auto_*`-adjacent fields; the matcher is pure.

- [ ] **Step 1: Write the failing matcher test**

```ts
// backend/src/split/applySplitRules.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSplitRule, type SplitRuleLike } from './applySplitRules';

const rules: SplitRuleLike[] = [
  { id: 1, matchCategory: 'Groceries', matchMerchant: null, matchAccountId: null, minAmountAbs: '50', splitType: 'shared', pctMe: '0.6', pctPartner: '0.4', priority: 10, enabled: true },
  { id: 2, matchCategory: null, matchMerchant: 'NETFLIX', matchAccountId: null, minAmountAbs: null, splitType: 'shared', pctMe: '0.5', pctPartner: '0.5', priority: 20, enabled: true },
  { id: 3, matchCategory: 'Groceries', matchMerchant: null, matchAccountId: null, minAmountAbs: null, splitType: 'me', pctMe: null, pctPartner: null, priority: 5, enabled: false },
];

test('matches the lowest-priority enabled rule whose criteria all hold', () => {
  const m = matchSplitRule({ finalCategory: 'Groceries', merchantRaw: 'Loblaws', amount: -80 }, rules);
  assert.equal(m?.id, 1); // rule 3 is lower priority but disabled
});

test('amount threshold excludes below-threshold txns', () => {
  const m = matchSplitRule({ finalCategory: 'Groceries', merchantRaw: 'Loblaws', amount: -20 }, rules);
  assert.equal(m, null);
});

test('merchant match is case-insensitive substring', () => {
  const m = matchSplitRule({ finalCategory: 'Subscriptions', merchantClean: 'Netflix Inc', amount: -16 }, rules);
  assert.equal(m?.id, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/split/applySplitRules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the matcher**

```ts
// backend/src/split/applySplitRules.ts
export type SplitRuleLike = {
  id: number;
  matchCategory: string | null;
  matchMerchant: string | null;
  matchAccountId: number | null;
  minAmountAbs: string | null;
  splitType: 'me' | 'partner' | 'shared';
  pctMe: string | null;
  pctPartner: string | null;
  priority: number;
  enabled: boolean;
};

type TxnLike = {
  finalCategory?: string | null;
  merchantClean?: string | null;
  merchantRaw?: string;
  accountId?: number | null;
  amount: number | string;
};

/** Lowest-priority enabled rule whose every SET criterion matches, else null. */
export function matchSplitRule(txn: TxnLike, rules: SplitRuleLike[]): SplitRuleLike | null {
  const merchant = (txn.merchantClean ?? txn.merchantRaw ?? '').toLowerCase();
  const amountAbs = Math.abs(Number(txn.amount));
  const candidates = rules
    .filter((r) => r.enabled)
    .filter((r) => {
      if (r.matchCategory != null && r.matchCategory !== txn.finalCategory) return false;
      if (r.matchMerchant != null && !merchant.includes(r.matchMerchant.toLowerCase())) return false;
      if (r.matchAccountId != null && r.matchAccountId !== txn.accountId) return false;
      if (r.minAmountAbs != null && amountAbs < Number(r.minAmountAbs)) return false;
      return true;
    })
    .sort((a, b) => a.priority - b.priority);
  return candidates[0] ?? null;
}
```

- [ ] **Step 4: Add `splitRuleId` column + model field**

Migration:

```js
// backend/src/migrations/20260618100005-transaction-split-rule-id.js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'split_rule_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'split_rules', key: 'id' },
      onDelete: 'SET NULL',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('transactions', 'split_rule_id');
  },
};
```

In `backend/src/models/Transaction.ts`, add the declaration near the other split fields:

```ts
  declare splitRuleId: CreationOptional<number | null>;
```

and the attribute in `Transaction.init` near the split fields:

```ts
      splitRuleId: { type: DataTypes.INTEGER, field: 'split_rule_id', allowNull: true },
```

- [ ] **Step 5: Add the rule tier to `recomputeTransactionAmounts`**

In `backend/src/import/calculateShares.ts`, read rule-derived fields and slot them between override and auto. Add after the `pctPartnerOverride`/`autoPctPartner` reads:

```ts
  const ruleSplitType = get<string | null>(t, 'ruleSplitType', 'rule_split_type');
  const rulePctMe = get<string | number | null>(t, 'rulePctMe', 'rule_pct_me');
  const rulePctPartner = get<string | number | null>(t, 'rulePctPartner', 'rule_pct_partner');
```

> The route layer writes `rule_split_type` / `rule_pct_me` / `rule_pct_partner`
> as transient computed inputs (NOT persisted columns) when applying a rule;
> they ride alongside `auto_*` so the same priority chain resolves them. If you
> prefer persistence, reuse the existing `auto_split_type` / `auto_pct_*` columns
> for rule output — but keep `splitRuleId` as the provenance marker so a manual
> `pctMeOverride` still wins. This plan uses the transient-field approach to
> avoid new auto columns.

Change `finalSplitType` / `finalPctMe` / `finalPctPartner` to insert the rule tier:

```ts
  const finalSplitType =
    splitOverride != null && splitOverride !== ''
      ? splitOverride
      : ruleSplitType != null && ruleSplitType !== ''
        ? ruleSplitType
        : autoSplitType || 'me';
  const finalPctMe =
    pctMeOverride != null && pctMeOverride !== ''
      ? Number(pctMeOverride)
      : rulePctMe != null && rulePctMe !== ''
        ? Number(rulePctMe)
        : autoPctMe != null && autoPctMe !== ''
          ? Number(autoPctMe)
          : null;
  const finalPctPartner =
    pctPartnerOverride != null && pctPartnerOverride !== ''
      ? Number(pctPartnerOverride)
      : rulePctPartner != null && rulePctPartner !== ''
        ? Number(rulePctPartner)
        : autoPctPartner != null && autoPctPartner !== ''
          ? Number(autoPctPartner)
          : null;
```

- [ ] **Step 6: Write the priority test**

```ts
// add to backend/src/import/calculateShares.test.ts (create the file if absent, importing recomputeTransactionAmounts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recomputeTransactionAmounts } from './calculateShares';

test('recompute: manual override beats rule tier', () => {
  const out = recomputeTransactionAmounts({
    amount: -100,
    pctMeOverride: 0.9, pctPartnerOverride: 0.1, splitOverride: 'shared',
    ruleSplitType: 'shared', rulePctMe: 0.5, rulePctPartner: 0.5,
  });
  assert.equal(out.finalPctMe, 0.9);
});

test('recompute: rule tier beats auto', () => {
  const out = recomputeTransactionAmounts({
    amount: -100,
    ruleSplitType: 'shared', rulePctMe: 0.6, rulePctPartner: 0.4,
    autoSplitType: 'me',
  });
  assert.equal(out.finalSplitType, 'shared');
  assert.equal(out.finalPctMe, 0.6);
});
```

- [ ] **Step 7: Run matcher + recompute tests + typecheck**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/split/applySplitRules.test.ts --test src/import/calculateShares.test.ts && yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/split/applySplitRules.ts backend/src/split/applySplitRules.test.ts backend/src/migrations/20260618100005-transaction-split-rule-id.js backend/src/models/Transaction.ts backend/src/import/calculateShares.ts backend/src/import/calculateShares.test.ts
git commit -m "feat(split): rule matcher + rule tier in share recompute"
```

---

### Task 11: SplitRule CRUD + apply-over-history route

**Files:**
- Create: `backend/src/routes/splitRules.ts`
- Modify: `backend/src/routeRegistry.ts` (mount under `/api/split-rules`, gated)
- Test: `backend/test/integration/splitRules.test.ts`

**Interfaces:**
- Produces: `GET /api/split-rules`, `POST /api/split-rules`, `PATCH /api/split-rules/:id`, `DELETE /api/split-rules/:id` (all `householdWhere`-scoped); `POST /api/split-rules/:id/apply` — re-applies a rule across the household's *un-overridden* transactions (skips any txn with a non-null `pctMeOverride`/`splitOverride`), setting `splitRuleId` + recomputing shares.

- [ ] **Step 1: Write the route (CRUD)**

```ts
// backend/src/routes/splitRules.ts
import { Router } from 'express';
import { SplitRule, Transaction } from '../models';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';
import { currentAuth } from '../auth/middleware';
import { matchSplitRule } from '../split/applySplitRules';
import { recomputeTransactionAmounts } from '../import/calculateShares';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const rules = await SplitRule.findAll({ where: householdWhere(req), order: [['priority', 'ASC'], ['id', 'ASC']] });
    res.json({ rules });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { householdId } = currentAuth(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rule = await SplitRule.create({
      householdId,
      name: String(b.name ?? '').trim() || 'Untitled rule',
      matchCategory: b.matchCategory ? String(b.matchCategory) : null,
      matchMerchant: b.matchMerchant ? String(b.matchMerchant) : null,
      matchAccountId: b.matchAccountId != null ? Number(b.matchAccountId) : null,
      minAmountAbs: b.minAmountAbs != null && b.minAmountAbs !== '' ? String(b.minAmountAbs) : null,
      splitType: (b.splitType === 'me' || b.splitType === 'partner') ? b.splitType : 'shared',
      pctMe: b.pctMe != null && b.pctMe !== '' ? String(b.pctMe) : null,
      pctPartner: b.pctPartner != null && b.pctPartner !== '' ? String(b.pctPartner) : null,
      priority: b.priority != null ? Number(b.priority) : 100,
      enabled: b.enabled == null ? true : Boolean(b.enabled),
    });
    res.status(201).json({ rule });
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const rule = await SplitRule.findOne({ where: { id: Number(req.params.id), ...householdWhere(req) } });
    if (!rule) { res.status(404).json({ error: 'Not found' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'matchCategory', 'matchMerchant', 'matchAccountId', 'minAmountAbs', 'splitType', 'pctMe', 'pctPartner', 'priority', 'enabled'] as const) {
      if (k in b) patch[k] = b[k];
    }
    await rule.update(patch);
    res.json({ rule });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const rule = await SplitRule.findOne({ where: { id: Number(req.params.id), ...householdWhere(req) } });
    if (!rule) { res.status(404).json({ error: 'Not found' }); return; }
    await rule.destroy();
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/:id/apply', async (req, res, next) => {
  try {
    const rule = await SplitRule.findOne({ where: { id: Number(req.params.id), ...householdWhere(req) } });
    if (!rule) { res.status(404).json({ error: 'Not found' }); return; }
    const txns = await Transaction.findAll({ where: visibleTransactionWhere(req) });
    let applied = 0;
    for (const t of txns) {
      // Manual overrides win — never clobber.
      if (t.get('pctMeOverride') != null || t.get('splitOverride') != null) continue;
      const match = matchSplitRule({
        finalCategory: t.get('finalCategory') as string | null,
        merchantClean: t.get('merchantClean') as string | null,
        merchantRaw: t.get('merchantRaw') as string,
        accountId: t.get('accountId') as number | null,
        amount: t.get('amount') as number | string,
      }, [rule.toJSON() as never]);
      if (!match) continue;
      t.set('ruleSplitType' as never, rule.splitType as never);
      t.set('rulePctMe' as never, rule.pctMe as never);
      t.set('rulePctPartner' as never, rule.pctPartner as never);
      t.set('splitRuleId' as never, rule.id as never);
      recomputeTransactionAmounts(t);
      await t.save();
      applied += 1;
    }
    res.json({ applied });
  } catch (e) { next(e); }
});

export default router;
```

> `ruleSplitType`/`rulePctMe`/`rulePctPartner` are transient instance values read
> by `recomputeTransactionAmounts`; they are not persisted columns. `set` with the
> `as never` cast is required because they are not declared model attributes.

- [ ] **Step 2: Mount in the registry**

In `backend/src/routeRegistry.ts`, add to `gatedRoutes` (import the router at the top following the existing import style):

```ts
  { path: '/api/split-rules', router: splitRulesRouter, why: 'Household split rules CRUD + apply-over-history; gated, household-scoped.' },
```

- [ ] **Step 3: Write the integration test**

```ts
// backend/test/integration/splitRules.test.ts — follow the nearest existing integration test's setup.
// Assertions:
//  - POST /api/split-rules creates a rule scoped to the household.
//  - POST /api/split-rules/:id/apply sets split_rule_id + partner_share_amount on a matching txn.
//  - A txn with pctMeOverride set is NOT modified by apply.
//  - A rule from another household is invisible (404 on PATCH).
```

- [ ] **Step 4: Run integration + typecheck**

Run: `cd backend && yarn workspace cashflow-backend run test:integration 2>&1 | tail -20 && yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/splitRules.ts backend/src/routeRegistry.ts backend/test/integration/splitRules.test.ts
git commit -m "feat(split): SplitRule CRUD + apply-over-history route"
```

---

### Task 12: Bulk-split endpoint

**Files:**
- Modify: `backend/src/routes/transactions.ts` (add `POST /bulk-split`)
- Test: `backend/test/integration/bulkSplit.test.ts`

**Interfaces:**
- Produces: `POST /api/transactions/bulk-split` body `{ ids: number[]; splitType: 'me'|'partner'|'shared'; pctMe?: number; pctPartner?: number }` → sets `splitOverride` + `pctMeOverride`/`pctPartnerOverride` on each visible txn and recomputes. Returns `{ updated: number }`. Sets overrides (manual intent), so it deliberately wins over rules.

- [ ] **Step 1: Implement the handler**

In `backend/src/routes/transactions.ts`, add near the other POST handlers:

```ts
router.post('/bulk-split', async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isFinite) : [];
    const splitType = b.splitType === 'me' || b.splitType === 'partner' ? b.splitType : 'shared';
    if (ids.length === 0) { res.status(400).json({ error: 'ids required' }); return; }
    const pctMe = b.pctMe != null && b.pctMe !== '' ? Number(b.pctMe) : null;
    const pctPartner = b.pctPartner != null && b.pctPartner !== '' ? Number(b.pctPartner) : null;
    if (splitType === 'shared') {
      for (const [label, v] of [['pctMe', pctMe], ['pctPartner', pctPartner]] as const) {
        if (v != null && (!Number.isFinite(v) || v < 0 || v > 1)) {
          res.status(400).json({ error: `${label} must be between 0 and 1` }); return;
        }
      }
    }
    const txns = await Transaction.findAll({ where: { id: { [Op.in]: ids }, ...visibleTransactionWhere(req) } });
    let updated = 0;
    for (const t of txns) {
      t.set('splitOverride', splitType as never);
      t.set('pctMeOverride', (splitType === 'shared' ? pctMe : null) as never);
      t.set('pctPartnerOverride', (splitType === 'shared' ? pctPartner : null) as never);
      recomputeTransactionAmounts(t);
      await t.save();
      updated += 1;
    }
    res.json({ updated });
  } catch (e) { next(e); }
});
```

> Confirm `Op`, `visibleTransactionWhere`, and `recomputeTransactionAmounts` are
> imported in `transactions.ts` (the file already uses all three). Place this
> route BEFORE any `/:id` route so `bulk-split` isn't captured as an id.

- [ ] **Step 2: Write the integration test**

```ts
// backend/test/integration/bulkSplit.test.ts — follow the nearest existing integration test's setup.
// Assertions:
//  - POST /api/transactions/bulk-split { ids:[a,b], splitType:'shared', pctMe:0.5, pctPartner:0.5 }
//    sets partner_share_amount to half on both.
//  - splitType:'me' zeroes partner_share_amount.
//  - ids from another household are not updated (visibleTransactionWhere scoping).
```

- [ ] **Step 3: Run integration + typecheck**

Run: `cd backend && yarn workspace cashflow-backend run test:integration 2>&1 | tail -20 && yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/transactions.ts backend/test/integration/bulkSplit.test.ts
git commit -m "feat(split): bulk-split transactions endpoint"
```

---

## Phase 4 — Frontend

### Task 13: Shared DTOs

**Files:**
- Modify: `shared/api-types.ts`

**Interfaces:**
- Produces: `SplitRuleDto`, `BulkSplitRequest`, `BulkSplitResponse`, `ApplySplitRuleResponse`. (Fairness DTOs already exist; `byCurrency`/`excludeNonPartnerInflows` shapes are unchanged — projection is server-side, the wire shape is identical.)

- [ ] **Step 1: Add the types**

```ts
// in shared/api-types.ts
export type SplitRuleDto = {
  id: number;
  name: string;
  matchCategory: string | null;
  matchMerchant: string | null;
  matchAccountId: number | null;
  minAmountAbs: string | null;
  splitType: 'me' | 'partner' | 'shared';
  pctMe: string | null;
  pctPartner: string | null;
  priority: number;
  enabled: boolean;
};

export type BulkSplitRequest = {
  ids: number[];
  splitType: 'me' | 'partner' | 'shared';
  pctMe?: number;
  pctPartner?: number;
};
export type BulkSplitResponse = { updated: number };
export type ApplySplitRuleResponse = { applied: number };
```

- [ ] **Step 2: Typecheck both workspaces**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace frontend run build 2>&1 | tail -5`
Expected: clean (no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add shared/api-types.ts
git commit -m "feat(shared): split-rule + bulk-split DTOs"
```

---

### Task 14: Share-accounts onboarding section

**Files:**
- Create: `frontend/src/pages/settings/sections/ShareAccountsSection.tsx`
- Modify: the Settings page that renders sections (mirror where `PartnerInviteSection` is rendered) to include `<ShareAccountsSection />`.
- Test: `frontend/src/pages/settings/sections/ShareAccountsSection.test.tsx`

**Interfaces:**
- Consumes: existing accounts API (`GET /api/accounts`) and the existing per-account visibility PATCH. **Before implementing, confirm the exact account-visibility mutation**: grep for `visibility` in `backend/src/routes/accounts.ts` and reuse that endpoint; if no such PATCH exists, add `PATCH /api/accounts/:id` accepting `{ visibility }` (household-scoped) as a prerequisite sub-step and test it.
- Produces: a section listing the member's accounts with a shared/private toggle each, persisting via the visibility mutation.

- [ ] **Step 1: Verify the visibility mutation exists**

Run: `cd backend && grep -n "visibility" src/routes/accounts.ts`
Expected: find a PATCH path that accepts `visibility`. If absent, implement it first (household-scoped PATCH, TDD with an integration test) and commit separately before continuing.

- [ ] **Step 2: Write the component test**

```tsx
// frontend/src/pages/settings/sections/ShareAccountsSection.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ShareAccountsSection } from './ShareAccountsSection';

vi.mock('../../../lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ accounts: [{ id: 1, name: 'Chequing', visibility: 'private' }] }), patch: vi.fn().mockResolvedValue({}) },
}));

describe('ShareAccountsSection', () => {
  it('lists accounts with a share toggle', async () => {
    render(<ShareAccountsSection />);
    expect(await screen.findByText('Chequing')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /share/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `yarn workspace frontend run test ShareAccountsSection`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the component**

Build `ShareAccountsSection.tsx` using existing design-system primitives (match `PartnerInviteSection.tsx` for layout/imports). Fetch accounts on mount, render each with a toggle bound to `visibility === 'shared'`, and PATCH on change. Use Tailwind utilities (no raw CSS). Keep it under one focused file.

- [ ] **Step 5: Run test + frontend lint**

Run: `yarn workspace frontend run test ShareAccountsSection && yarn workspace frontend run lint`
Expected: PASS; lint clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/sections/ShareAccountsSection.tsx frontend/src/pages/settings/sections/ShareAccountsSection.test.tsx
git commit -m "feat(frontend): share-accounts onboarding section"
```

---

### Task 15: Partner home page

**Files:**
- Create: `frontend/src/pages/PartnerHomePage.tsx`
- Modify: `frontend/src/` router (add a `/partner-home` route mirroring how `/partner` is registered) + nav entry.
- Test: `frontend/src/pages/PartnerHomePage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/partner/fairness` (now viewer-projected) + `GET /api/accounts`. No new endpoint — the page composes existing ones.
- Produces: a landing surface showing, viewer-relative: current balance + direction, shared spend, and an empty-state ("Nothing shared yet — share accounts") linking to the ShareAccounts section when no shared accounts exist.

- [ ] **Step 1: Write the component test**

```tsx
// frontend/src/pages/PartnerHomePage.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PartnerHomePage } from './PartnerHomePage';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn((url: string) =>
      url.includes('/partner/fairness')
        ? Promise.resolve({ byCurrency: [{ currency: 'CAD', balance: -50, direction: 'i_owe_partner', currentMonthSharedSpend: 120 }], excludeNonPartnerInflows: true })
        : Promise.resolve({ accounts: [{ id: 1, visibility: 'shared' }] }),
    ),
  },
}));

describe('PartnerHomePage', () => {
  it('shows the viewer-relative balance direction', async () => {
    render(<PartnerHomePage />);
    expect(await screen.findByText(/you owe/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn workspace frontend run test PartnerHomePage`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the page**

Build `PartnerHomePage.tsx`: fetch fairness + accounts; render the balance card (map `direction` → "Partner owes you" / "You owe partner" / "Settled up"), shared spend, and the empty-state when no `visibility === 'shared'` account exists. Reuse existing card/heading primitives; Tailwind only.

- [ ] **Step 4: Register the route + nav**

Add `/partner-home` to the router config (mirror the `/partner` registration) and a nav link. Verify by running the build.

- [ ] **Step 5: Run test + build**

Run: `yarn workspace frontend run test PartnerHomePage && yarn workspace frontend run build 2>&1 | tail -5`
Expected: PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/PartnerHomePage.tsx frontend/src/pages/PartnerHomePage.test.tsx
git commit -m "feat(frontend): partner home page (viewer-relative)"
```

---

### Task 16: Bulk-split UI on the transactions list

**Files:**
- Modify: the transactions list page/component under `frontend/src/pages/` (the one rendering the transaction table) to add multi-select + a "Split selected" action calling `POST /api/transactions/bulk-split`.
- Test: a colocated `*.test.tsx` for the bulk-split action.

**Interfaces:**
- Consumes: `BulkSplitRequest` / `BulkSplitResponse` from `@cashflow/shared`; `api.post('/transactions/bulk-split', body)`.
- Produces: row checkboxes + a toolbar action with a small dialog (50/50 · custom pct · me/partner), posting selected ids and refreshing the list.

- [ ] **Step 1: Locate the transactions list component**

Run: `cd frontend && grep -rln "transactions" src/pages | head` and identify the table component. Read it to match its selection/state patterns.

- [ ] **Step 2: Write the action test**

Write a colocated test that renders the table with two rows, selects both, triggers "Split selected → 50/50", and asserts `api.post` was called with `{ ids: [...], splitType: 'shared', pctMe: 0.5, pctPartner: 0.5 }`. Mock `../lib/api`.

- [ ] **Step 3: Run to verify it fails**

Run: `yarn workspace frontend run test <TableTestName>`
Expected: FAIL.

- [ ] **Step 4: Implement**

Add selection state + toolbar action + a minimal dialog (reuse existing dialog/radix primitives). Post and refetch on success. Tailwind only.

- [ ] **Step 5: Run test + lint**

Run: `yarn workspace frontend run test <TableTestName> && yarn workspace frontend run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/<files>
git commit -m "feat(frontend): bulk-split action on transactions list"
```

---

### Task 17: Split-rules management tab

**Files:**
- Create: `frontend/src/pages/settings/tabs/SplitRulesTab.tsx`
- Modify: the settings tabs registry (mirror `MembersTab` registration) to add the tab.
- Test: `frontend/src/pages/settings/tabs/SplitRulesTab.test.tsx`

**Interfaces:**
- Consumes: `SplitRuleDto` + `ApplySplitRuleResponse`; `api.get/post/patch/delete('/split-rules...')`.
- Produces: list of rules, create/edit form (name, match criteria, split type + pct, priority, enabled), delete, and an "Apply to history" button hitting `POST /api/split-rules/:id/apply` that surfaces the `applied` count.

- [ ] **Step 1: Write the component test**

```tsx
// frontend/src/pages/settings/tabs/SplitRulesTab.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SplitRulesTab } from './SplitRulesTab';

vi.mock('../../../lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ rules: [{ id: 1, name: 'Groceries 60/40', splitType: 'shared', pctMe: '0.6', pctPartner: '0.4', priority: 10, enabled: true, matchCategory: 'Groceries', matchMerchant: null, matchAccountId: null, minAmountAbs: null }] }), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('SplitRulesTab', () => {
  it('lists existing rules', async () => {
    render(<SplitRulesTab />);
    expect(await screen.findByText('Groceries 60/40')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn workspace frontend run test SplitRulesTab`
Expected: FAIL.

- [ ] **Step 3: Implement the tab**

Build the tab (mirror `MembersTab.tsx` structure). List + form + delete + apply. Tailwind only; reuse form primitives.

- [ ] **Step 4: Register the tab + run test + lint**

Add the tab to the settings tabs registry. Run: `yarn workspace frontend run test SplitRulesTab && yarn workspace frontend run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/settings/tabs/SplitRulesTab.tsx frontend/src/pages/settings/tabs/SplitRulesTab.test.tsx
git commit -m "feat(frontend): split-rules management tab"
```

---

### Task 18: Full CI gate

**Files:** none (verification task).

- [ ] **Step 1: Run the full backend unit suite**

Run: `cd backend && bash scripts/run-unit-tests.sh 2>&1 | tail -20`
Expected: all pass, non-zero file count.

- [ ] **Step 2: Run integration (Postgres)**

Run: `cd backend && yarn workspace cashflow-backend run test:integration 2>&1 | tail -20`
Expected: pass (requires `TEST_DATABASE_URL`).

- [ ] **Step 3: Run the whole CI target**

Run: `yarn ci 2>&1 | tail -30`
Expected: typecheck + all tests + both production builds pass.

- [ ] **Step 4: Apply migrations on a scratch DB to confirm up/down**

Run: `cd backend && yarn db:migrate && yarn workspace cashflow-backend run db:migrate:undo && yarn db:migrate`
Expected: migrations apply, the most recent undoes cleanly, re-applies.

- [ ] **Step 5: Commit any fixups, then finish the branch**

Push the branch, open a PR, enable auto-merge with a merge commit (per repo conventions).

---

## Self-Review

**Spec coverage:**
- Component 1 (one partner identity): Tasks 1–4 (Contact.userId, resolver+hook, backfill, settlement attribution). ✓
- Component 2 (viewer projection): Tasks 5–8 (payerUserId, fairness projection, monthly, settlement direction + route wiring). ✓
- Component 3 (sharing onboarding + partner home): Tasks 14–15. ✓
- Component 4 (effortless splitting): Tasks 9–12 (model, matcher+priority, CRUD+apply, bulk). ✓
- Data changes (Contact.userId, split_rules, transactions.split_rule_id, settlement recorded_by, backfill): Tasks 1,2,3,4,9,10. ✓
- Testing (projection invariant, invite-accept, backfill, rule priority, visibility): covered across Tasks 2,3,6,7,8,10,11,12. ✓
- Out-of-scope items (N-party, reimbursements, nudges): not implemented. ✓

**Type consistency:** `viewerUserId`/`payerUserId`/`balanceContribution`/`projectRow` consistent Tasks 5–8; `ruleSplitType`/`rulePctMe`/`rulePctPartner` transient fields consistent Tasks 10–11; `SplitRuleLike` shape matches `SplitRule` model fields Tasks 9–11; `splitRuleId` provenance consistent Tasks 10–11.

**Known soft spots flagged inline for the implementer** (not placeholders — explicit verification sub-steps): exact account-visibility mutation (Task 14 Step 1), the transactions-list component location (Task 16 Step 1), and integration-test harness helpers (Tasks 8/11/12 reference "the nearest existing integration test"). These require reading current code at execution time rather than guessing a path in the plan.
