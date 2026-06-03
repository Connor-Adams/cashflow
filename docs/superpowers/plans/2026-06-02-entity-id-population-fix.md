# Entity ID Population Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop accounts and transactions from being created with `entity_id=NULL` (which silently excludes them from the T1/T2 tax engine), provide an idempotent repair path, and fix the dead WS-corp-account-link migration.

**Architecture:** App-level Sequelize hooks (no DB triggers). An `Account.beforeCreate`/`beforeBulkCreate` hook fills `entityId` from the household's `personal` tax entity (created on demand via `getOrCreatePersonalEntity`) when not explicitly set — explicit corp tagging still wins. A `Transaction.beforeCreate`/`beforeBulkCreate` hook inherits `entityId` from the owning account when null. A reusable `syncTransactionEntityIds(householdId?)` service re-asserts the invariant (a txn's entity mirrors its account's) and is invoked at bundle-import completion. `resolveEntityForHolder` is made case-insensitive + idempotent so corp entities don't duplicate across statement casings, and the WS bundle importer is wired to it so WS corp accounts link to the corp entity. The dead migration is superseded by a new idempotent, case-insensitive reconciliation migration.

**Tech Stack:** TypeScript, Sequelize 6 (sqlite in tests, Postgres in prod), Node built-in test runner via `tsx`.

This fixes field-population on the **Account** and **Transaction** primitives — NOT a new primitive (per CLAUDE.md spine rule).

---

## File Structure

- **Create** `backend/src/tax/services/getOrCreatePersonalEntity.ts` — helper that returns (creating if absent) the household's single `personal` Entity.
- **Create** `backend/src/tax/services/syncTransactionEntityIds.ts` — idempotent repair: `UPDATE transactions SET entity_id = account.entity_id` where they diverge.
- **Modify** `backend/src/models/Account.ts` — add `beforeCreate`/`beforeBulkCreate` hooks that fill `entityId` from the personal entity when null.
- **Modify** `backend/src/models/Transaction.ts` — add `beforeCreate`/`beforeBulkCreate` hooks that inherit `entityId` from the account when null.
- **Modify** `backend/src/import/runImport.ts` — make `resolveEntityForHolder` case-insensitive + idempotent; wire `importWsBundleFile` to resolve+link the corp entity for WS corp accounts.
- **Modify** `backend/src/routes/import.ts` — call `syncTransactionEntityIds(household.id)` after each bundle (WS + PDF) completes.
- **Create** `backend/src/migrations/20260602000010-reconcile-corp-account-entities.js` — new idempotent, case-insensitive corp-account→corp-entity reconciliation that supersedes the dead `20260601000001`.
- **Tests:**
  - `backend/test/getOrCreatePersonalEntity.test.ts`
  - `backend/test/accountEntityIdHook.test.ts`
  - `backend/test/transactionEntityIdHook.test.ts`
  - `backend/test/syncTransactionEntityIds.test.ts`
  - `backend/test/resolveEntityForHolder.test.ts` (extend existing) — case-insensitive match
  - `backend/test/migrations/reconcileCorpAccountEntitiesMigration.test.ts`

---

## Task 1: `getOrCreatePersonalEntity` helper

The hooks need the household's `personal` entity, but no code creates one today (only the one-time backfill migration did). This helper creates it on demand (legalName `'Personal'`, jurisdiction `'CA-ON'` — matching the backfill convention), idempotently.

**Files:**
- Create: `backend/src/tax/services/getOrCreatePersonalEntity.ts`
- Test: `backend/test/getOrCreatePersonalEntity.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Entity: typeof import('../src/models/Entity').Entity;
let Household: typeof import('../src/models/Household').Household;
let getOrCreatePersonalEntity: typeof import('../src/tax/services/getOrCreatePersonalEntity').getOrCreatePersonalEntity;

before(async () => {
  const models = await import('../src/models');
  sequelize = models.sequelize;
  Entity = models.Entity;
  Household = models.Household;
  ({ getOrCreatePersonalEntity } = await import('../src/tax/services/getOrCreatePersonalEntity'));
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });

let householdId: number;
beforeEach(async () => {
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
});

test('creates a personal entity when none exists', async () => {
  const e = await getOrCreatePersonalEntity(householdId);
  assert.equal(e.kind, 'personal');
  assert.equal(e.householdId, householdId);
  assert.equal(e.legalName, 'Personal');
  assert.equal((await Entity.count({ where: { householdId, kind: 'personal' } })), 1);
});

test('is idempotent — reuses the existing personal entity', async () => {
  const first = await getOrCreatePersonalEntity(householdId);
  const second = await getOrCreatePersonalEntity(householdId);
  assert.equal(first.id, second.id);
  assert.equal((await Entity.count({ where: { householdId, kind: 'personal' } })), 1);
});

test('does not return a corp entity', async () => {
  await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const e = await getOrCreatePersonalEntity(householdId);
  assert.equal(e.kind, 'personal');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/getOrCreatePersonalEntity.test.ts`
Expected: FAIL — cannot resolve module `getOrCreatePersonalEntity`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { Entity } from '../../models';
import type { Transaction as SequelizeTransaction } from 'sequelize';

/**
 * Returns the household's single `personal` tax Entity, creating it on demand.
 *
 * No production code path created a personal Entity at household creation —
 * historically only the one-time backfill migration (20260525000008) did, so
 * households created after that migration had none. The account-creation hook
 * relies on this helper to guarantee a personal entity exists to default to.
 *
 * Idempotent: a unique-ish (household_id, kind='personal') invariant is held at
 * the app level. Pass `transaction` so creation participates in the caller's
 * unit of work (the account hook fills entity_id inside the same insert txn).
 */
export async function getOrCreatePersonalEntity(
  householdId: number,
  options?: { transaction?: SequelizeTransaction },
): Promise<InstanceType<typeof Entity>> {
  const [entity] = await Entity.findOrCreate({
    where: { householdId, kind: 'personal' },
    defaults: {
      householdId,
      kind: 'personal',
      legalName: 'Personal',
      jurisdiction: 'CA-ON',
    },
    transaction: options?.transaction,
  });
  return entity;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/getOrCreatePersonalEntity.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/tax/services/getOrCreatePersonalEntity.ts backend/test/getOrCreatePersonalEntity.test.ts
git commit -m "feat(tax): add getOrCreatePersonalEntity helper"
```

---

## Task 2: Account hook fills `entity_id` (default personal)

**Files:**
- Modify: `backend/src/models/Account.ts`
- Test: `backend/test/accountEntityIdHook.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models/Account').Account;
let Entity: typeof import('../src/models/Entity').Entity;
let Household: typeof import('../src/models/Household').Household;

before(async () => {
  const models = await import('../src/models');
  ({ sequelize, Account, Entity, Household } = models);
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });

let householdId: number;
beforeEach(async () => {
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
});

test('new account with no entityId gets the household personal entity', async () => {
  const a = await Account.create({ name: 'Chequing', owner: 'me', householdId });
  const personal = await Entity.findOne({ where: { householdId, kind: 'personal' } });
  assert.ok(personal, 'personal entity should have been created');
  assert.equal(a.entityId, personal!.id);
});

test('explicit entityId (e.g. corp) is preserved — not overwritten', async () => {
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const a = await Account.create({ name: 'Corp Chequing', owner: 'me', householdId, entityId: corp.id });
  assert.equal(a.entityId, corp.id);
  assert.equal((await Entity.count({ where: { householdId, kind: 'personal' } })), 0);
});

test('account without a householdId is left null (no entity to default to)', async () => {
  const a = await Account.create({ name: 'Orphan', owner: 'me', householdId: null });
  assert.equal(a.entityId, null);
});

test('findOrCreate path also fills entityId (bulk-safe)', async () => {
  const [a] = await Account.findOrCreate({
    where: { householdId, shortCode: 'WS1' },
    defaults: { name: 'WS', owner: 'me', householdId, shortCode: 'WS1' },
  });
  const personal = await Entity.findOne({ where: { householdId, kind: 'personal' } });
  assert.equal(a.entityId, personal!.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/accountEntityIdHook.test.ts`
Expected: FAIL — `a.entityId` is `null`, expected the personal entity id.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/models/Account.ts`, after `Account.init(...)` and before `return Account;`, add:

```typescript
  /**
   * Default entity_id to the household's `personal` tax entity when not
   * explicitly set. Accounts created with NULL entity_id are silently
   * excluded from the T1/T2 tax engine (buildPersonalFacts / buildCorpFacts
   * both query `where entityId=...`), so every account must carry one.
   * Explicit tagging (e.g. a corp account from the PDF importer) wins because
   * we only fill when null. Accounts without a household have no entity to
   * default to and are left null. Lazy import dodges the model<->service
   * circular dependency at init time.
   */
  const fillPersonalEntity = async (
    instance: Account,
    options: { transaction?: import('sequelize').Transaction },
  ): Promise<void> => {
    if (instance.entityId != null || instance.householdId == null) return;
    const { getOrCreatePersonalEntity } = await import(
      '../tax/services/getOrCreatePersonalEntity'
    );
    const personal = await getOrCreatePersonalEntity(instance.householdId, {
      transaction: options.transaction,
    });
    instance.entityId = personal.id;
  };
  Account.addHook('beforeCreate', fillPersonalEntity);
  Account.addHook('beforeBulkCreate', async (instances, options) => {
    for (const instance of instances) {
      await fillPersonalEntity(instance, options as { transaction?: import('sequelize').Transaction });
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/accountEntityIdHook.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/models/Account.ts backend/test/accountEntityIdHook.test.ts
git commit -m "feat(accounts): default entity_id to household personal entity on create"
```

---

## Task 3: Transaction hook inherits `entity_id` from account

**Files:**
- Modify: `backend/src/models/Transaction.ts`
- Test: `backend/test/transactionEntityIdHook.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models/Account').Account;
let Entity: typeof import('../src/models/Entity').Entity;
let Household: typeof import('../src/models/Household').Household;
let Transaction: typeof import('../src/models/Transaction').Transaction;

before(async () => {
  const models = await import('../src/models');
  ({ sequelize, Account, Entity, Household, Transaction } = models);
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });

let householdId: number;
beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
});

function txnDefaults(accountId: number, extra: Record<string, unknown> = {}) {
  return {
    accountId,
    householdId,
    date: '2026-01-15',
    merchantRaw: 'X',
    merchantClean: 'X',
    amount: '10.00',
    currency: 'CAD',
    importBatch: 'test',
    sourceRowFingerprint: `fp-${Math.random()}`,
    sourceIdentityFingerprint: `fp-${Math.random()}`,
    ...extra,
  };
}

test('new transaction inherits entityId from its account', async () => {
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const account = await Account.create({ name: 'Corp', owner: 'me', householdId, entityId: corp.id });
  const t = await Transaction.create(txnDefaults(account.id) as never);
  assert.equal(t.entityId, corp.id);
});

test('inherits the personal entity for a default (personal) account', async () => {
  const account = await Account.create({ name: 'Personal', owner: 'me', householdId });
  const personal = await Entity.findOne({ where: { householdId, kind: 'personal' } });
  const t = await Transaction.create(txnDefaults(account.id) as never);
  assert.equal(t.entityId, personal!.id);
});

test('explicit transaction entityId is preserved', async () => {
  const personal = await Entity.create({ householdId, kind: 'personal', legalName: 'Personal' });
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const account = await Account.create({ name: 'Personal', owner: 'me', householdId, entityId: personal.id });
  const t = await Transaction.create(txnDefaults(account.id, { entityId: corp.id }) as never);
  assert.equal(t.entityId, corp.id);
});

test('leaves entityId null when the account itself has none', async () => {
  const account = await Account.create({ name: 'Orphan', owner: 'me', householdId: null });
  const t = await Transaction.create(txnDefaults(account.id, { householdId: null }) as never);
  assert.equal(t.entityId, null);
});

test('build()+save() path (import) also inherits', async () => {
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const account = await Account.create({ name: 'Corp', owner: 'me', householdId, entityId: corp.id });
  const t = Transaction.build(txnDefaults(account.id) as never);
  await t.save();
  assert.equal(t.entityId, corp.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/transactionEntityIdHook.test.ts`
Expected: FAIL — `t.entityId` is `null`.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/models/Transaction.ts`, inside `initTransaction`, before `return Transaction;`, add:

```typescript
  /**
   * Inherit entity_id from the owning account when not explicitly set. The tax
   * engine keys income off transactions.entity_id (buildPersonalFacts /
   * buildCorpFacts use `where entityId=...`), so a NULL-entity transaction is
   * silently dropped from T1/T2 even when its account is correctly tagged.
   * Mirroring the account's entity at insert time keeps the invariant
   * (a txn's entity == its account's entity) without a DB trigger. Lazy import
   * of Account dodges init-order coupling.
   */
  const inheritEntityFromAccount = async (
    instance: Transaction,
    options: { transaction?: import('sequelize').Transaction },
  ): Promise<void> => {
    if (instance.entityId != null || instance.accountId == null) return;
    const { Account } = await import('./Account');
    const account = await Account.findByPk(instance.accountId, {
      attributes: ['id', 'entityId'],
      transaction: options.transaction,
    });
    if (account?.entityId != null) {
      instance.entityId = account.entityId;
    }
  };
  Transaction.addHook('beforeCreate', inheritEntityFromAccount);
  Transaction.addHook('beforeBulkCreate', async (instances, options) => {
    for (const instance of instances) {
      await inheritEntityFromAccount(instance, options as { transaction?: import('sequelize').Transaction });
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/transactionEntityIdHook.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/models/Transaction.ts backend/test/transactionEntityIdHook.test.ts
git commit -m "feat(transactions): inherit entity_id from account on create"
```

---

## Task 4: `syncTransactionEntityIds` repair service

**Files:**
- Create: `backend/src/tax/services/syncTransactionEntityIds.ts`
- Test: `backend/test/syncTransactionEntityIds.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models/Account').Account;
let Entity: typeof import('../src/models/Entity').Entity;
let Household: typeof import('../src/models/Household').Household;
let Transaction: typeof import('../src/models/Transaction').Transaction;
let syncTransactionEntityIds: typeof import('../src/tax/services/syncTransactionEntityIds').syncTransactionEntityIds;

before(async () => {
  const models = await import('../src/models');
  ({ sequelize, Account, Entity, Household, Transaction } = models);
  ({ syncTransactionEntityIds } = await import('../src/tax/services/syncTransactionEntityIds'));
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });

let householdId: number;
let personalId: number;
let corpId: number;
beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
  personalId = (await Entity.create({ householdId, kind: 'personal', legalName: 'Personal' })).id;
  corpId = (await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' })).id;
});

function rawTxn(accountId: number, entityId: number | null) {
  // Insert raw so we bypass the inheritance hook and simulate legacy/divergent rows.
  return sequelize.query(
    `INSERT INTO transactions
      (account_id, household_id, entity_id, date, merchant_raw, merchant_clean, amount, currency,
       import_batch, source_row_fingerprint, source_identity_fingerprint,
       visibility, ownership_type, status, final_business, final_split_type,
       my_share_amount, partner_share_amount, business_amount, txn_type, is_recurring,
       review_flag, created_at, updated_at)
     VALUES (:accountId, :householdId, :entityId, '2026-01-01', 'M', 'M', '1.0000', 'CAD',
       'b', :fp, :fp, 'private', 'me', 'posted', 0, 'me',
       0, 0, 0, 'purchase', 0, 0, :now, :now)`,
    { replacements: { accountId, householdId, entityId, fp: `fp-${Math.random()}`, now: new Date().toISOString() } },
  );
}

test('syncs mismatched and null transaction entity_ids to their account entity', async () => {
  const corpAccount = await Account.create({ name: 'Corp', owner: 'me', householdId, entityId: corpId });
  await rawTxn(corpAccount.id, null);        // NULL — should become corp
  await rawTxn(corpAccount.id, personalId);  // WRONG (personal) — should become corp

  const updated = await syncTransactionEntityIds(householdId);
  assert.equal(updated, 2);
  const rows = await Transaction.findAll({ where: { accountId: corpAccount.id } });
  assert.ok(rows.every((r) => r.entityId === corpId));
});

test('is idempotent — a second run updates nothing', async () => {
  const corpAccount = await Account.create({ name: 'Corp', owner: 'me', householdId, entityId: corpId });
  await rawTxn(corpAccount.id, null);
  assert.equal(await syncTransactionEntityIds(householdId), 1);
  assert.equal(await syncTransactionEntityIds(householdId), 0);
});

test('does not touch txns whose account entity_id is NULL', async () => {
  const nullAccount = await Account.create({ name: 'Orphan', owner: 'me', householdId: null });
  await rawTxn(nullAccount.id, null);
  assert.equal(await syncTransactionEntityIds(), 0);
  const [row] = await Transaction.findAll({ where: { accountId: nullAccount.id } });
  assert.equal(row.entityId, null);
});

test('scopes to a household when householdId is passed', async () => {
  const otherHh = (await Household.create({ name: 'Other' })).id;
  const otherCorp = (await Entity.create({ householdId: otherHh, kind: 'corp', legalName: 'Other Inc.' })).id;
  const a1 = await Account.create({ name: 'A1', owner: 'me', householdId, entityId: corpId });
  const a2 = await Account.create({ name: 'A2', owner: 'me', householdId: otherHh, entityId: otherCorp });
  await rawTxn(a1.id, null);
  await rawTxn(a2.id, null);
  // Only household 1's row should be synced.
  const updated = await syncTransactionEntityIds(householdId);
  assert.equal(updated, 1);
  const [r2] = await Transaction.findAll({ where: { accountId: a2.id } });
  assert.equal(r2.entityId, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/syncTransactionEntityIds.test.ts`
Expected: FAIL — cannot resolve module `syncTransactionEntityIds`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';

/**
 * Re-assert the invariant that a transaction's entity_id mirrors its account's
 * entity_id. Needed because nothing at the DB level enforces it: after bulk
 * imports or an account→entity reassignment, transactions can carry NULL or a
 * stale entity while their account is correctly tagged, which silently drops
 * them from the T1/T2 tax engine (which keys income off transactions.entity_id).
 *
 * Idempotent: only rows that diverge (`entity_id IS DISTINCT FROM
 * account.entity_id`) are touched, and only when the account actually has an
 * entity (`account.entity_id IS NOT NULL`) — we never blank out a txn. Pass a
 * householdId to scope the repair (e.g. right after that household's import);
 * omit it to repair globally.
 *
 * Returns the number of transaction rows updated.
 */
export async function syncTransactionEntityIds(householdId?: number): Promise<number> {
  const scope = householdId != null ? 'AND a.household_id = :householdId' : '';
  const [, affected] = await sequelize.query(
    `UPDATE transactions AS t
        SET entity_id = a.entity_id
       FROM accounts AS a
      WHERE t.account_id = a.id
        AND a.entity_id IS NOT NULL
        AND t.entity_id IS DISTINCT FROM a.entity_id
        ${scope}`,
    {
      type: QueryTypes.UPDATE,
      replacements: householdId != null ? { householdId } : {},
    },
  );
  return typeof affected === 'number' ? affected : 0;
}
```

> NOTE: SQLite (test DB) supports `UPDATE ... FROM` since 3.33 (bundled with the
> `sqlite3` npm package used here) and `IS DISTINCT FROM`. If the local sqlite
> build rejects either, the test in Step 4 will surface it and we fall back to a
> correlated-subquery form. Verify in Step 4 before assuming the syntax holds.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/syncTransactionEntityIds.test.ts`
Expected: PASS (4 tests). If a SQL-syntax error appears, switch the UPDATE to the correlated-subquery fallback:

```sql
UPDATE transactions
   SET entity_id = (SELECT a.entity_id FROM accounts a WHERE a.id = transactions.account_id)
 WHERE account_id IN (
   SELECT a.id FROM accounts a
    WHERE a.entity_id IS NOT NULL <scope>
 )
   AND entity_id IS DISTINCT FROM
       (SELECT a.entity_id FROM accounts a WHERE a.id = transactions.account_id)
```
(with `<scope>` = `AND a.household_id = :householdId` when scoped), then re-run.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tax/services/syncTransactionEntityIds.ts backend/test/syncTransactionEntityIds.test.ts
git commit -m "feat(tax): add idempotent syncTransactionEntityIds repair service"
```

---

## Task 5: Case-insensitive `resolveEntityForHolder` + WS corp linking

**Files:**
- Modify: `backend/src/import/runImport.ts:891-908` (`resolveEntityForHolder`) and `:761` (`importWsBundleFile`)
- Test: `backend/test/resolveEntityForHolder.test.ts` (extend) + `backend/test/wsBundleCorpLink.test.ts` (new)

- [ ] **Step 1: Write the failing tests (extend existing file)**

Append to `backend/test/resolveEntityForHolder.test.ts`:

```typescript
test('resolveEntityForHolder: matches existing corp entity case-insensitively', async () => {
  const existing = await Entity.create({
    householdId,
    kind: 'corp',
    legalName: 'CDG LABS INC.',
  });
  // A later statement spells it differently; must reuse, not duplicate.
  const got = await resolveEntityForHolder('CDG Labs Inc.', householdId);
  assert.ok(got);
  assert.equal(got!.id, existing.id);
  const all = await Entity.findAll();
  assert.equal(all.length, 1);
});

test('resolveEntityForHolder: does not duplicate across casings on repeated calls', async () => {
  const a = await resolveEntityForHolder('CDG Labs Inc.', householdId);
  const b = await resolveEntityForHolder('cdg labs inc.', householdId);
  const c = await resolveEntityForHolder('CDG LABS INC.', householdId);
  assert.equal(a!.id, b!.id);
  assert.equal(b!.id, c!.id);
  assert.equal((await Entity.findAll()).length, 1);
});
```

Create `backend/test/wsBundleCorpLink.test.ts`:

```typescript
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models/Account').Account;
let Entity: typeof import('../src/models/Entity').Entity;
let Household: typeof import('../src/models/Household').Household;
let linkWsAccountToCorpEntity: typeof import('../src/import/runImport').linkWsAccountToCorpEntity;

before(async () => {
  const models = await import('../src/models');
  ({ sequelize, Account, Entity, Household } = models);
  ({ linkWsAccountToCorpEntity } = await import('../src/import/runImport'));
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });

let householdId: number;
beforeEach(async () => {
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
});

test('links a WS corp account to the household corp entity (case-insensitive)', async () => {
  const corp = await Entity.create({ householdId, kind: 'corp', legalName: 'CDG LABS INC.' });
  const account = await Account.create({
    name: 'Wealthsimple Corporate Investing', owner: 'me', householdId, entityId: null,
  });
  await linkWsAccountToCorpEntity(account, 'corporate_investing', householdId);
  await account.reload();
  assert.equal(account.entityId, corp.id);
});

test('non-corp WS product leaves the account entity untouched', async () => {
  const account = await Account.create({ name: 'Wealthsimple TFSA', owner: 'me', householdId });
  const before = account.entityId;
  await linkWsAccountToCorpEntity(account, 'tfsa', householdId);
  await account.reload();
  assert.equal(account.entityId, before); // still the personal default from the hook
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/resolveEntityForHolder.test.ts test/wsBundleCorpLink.test.ts`
Expected: FAIL — case-insensitive match returns a new entity (count 2), and `linkWsAccountToCorpEntity` is not exported.

- [ ] **Step 3: Implement**

Replace `resolveEntityForHolder` in `backend/src/import/runImport.ts` with a case-insensitive lookup, and add a `linkWsAccountToCorpEntity` helper + the set of corp WS product hints. Add `import { fn, col, where as sqlWhere } from 'sequelize'` to the existing sequelize import if not present (use `Op`-free lower() match).

```typescript
export async function resolveEntityForHolder(
  holder: string | null | undefined,
  householdId: number,
): Promise<InstanceType<typeof Entity> | null> {
  if (!holder) return null;
  const trimmed = holder.trim();
  if (!trimmed) return null;
  // Case-insensitive match so statements that spell the corp differently
  // ("CDG Labs Inc." vs "CDG LABS INC.") reuse one Entity instead of forking.
  const existing = await Entity.findOne({
    where: sqlWhere(fn('lower', col('legal_name')), trimmed.toLowerCase()),
  });
  if (existing && existing.householdId === householdId) return existing;
  if (existing && existing.householdId !== householdId) {
    // A same-named entity in another household must not be reused; fall through
    // to per-household creation only if this looks like a corp.
  }
  if (!CORP_HOLDER_RE.test(trimmed)) return null;
  return Entity.create({ householdId, kind: 'corp', legalName: trimmed });
}

/** WS productHints that denote a corporate account. */
const WS_CORP_PRODUCT_HINTS = new Set([
  'corporate_investing',
  'save_for_business',
  'corporate_chequing',
]);

/**
 * Link a Wealthsimple corp account to the household's corp Entity. The WS
 * bundle importer (unlike the PDF importer) has no statement "accountHolder"
 * to resolve, so corp WS accounts historically ended up entity_id=NULL (or the
 * personal default). When a corp Entity already exists in the household (the
 * Wise/RBC importer auto-creates "CDG LABS INC."), we point the WS corp account
 * at it. Case-insensitive, idempotent, no-op for non-corp products or when no
 * corp entity exists yet.
 */
export async function linkWsAccountToCorpEntity(
  account: InstanceType<typeof Account>,
  productHint: string,
  householdId: number,
): Promise<void> {
  if (!WS_CORP_PRODUCT_HINTS.has(productHint)) return;
  const corp = await Entity.findOne({ where: { householdId, kind: 'corp' } });
  if (!corp) return;
  if (account.entityId !== corp.id) {
    await account.update({ entityId: corp.id });
  }
}
```

Wire it into `importWsBundleFile` right after the `Account.findOrCreate` block (after line ~773):

```typescript
  await linkWsAccountToCorpEntity(account, parsed.productHint, opts.householdId);
```

The `Account` import is already present in runImport.ts; ensure `sqlWhere`, `fn`, `col` are imported from `sequelize` at the top.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/resolveEntityForHolder.test.ts test/wsBundleCorpLink.test.ts`
Expected: PASS (all, including the pre-existing exact-match tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/runImport.ts backend/test/resolveEntityForHolder.test.ts backend/test/wsBundleCorpLink.test.ts
git commit -m "fix(import): case-insensitive corp entity match + WS corp account linking"
```

---

## Task 6: Invoke `syncTransactionEntityIds` at bundle-import completion

**Files:**
- Modify: `backend/src/routes/import.ts` (both `bundle_completed` and `pdf_bundle_completed` points: ~line 513 and ~577)

- [ ] **Step 1: Wire the call (covered by integration behavior; no new unit test — the service is unit-tested in Task 4 and the route is exercised by existing import integration tests)**

After the WS bundle loop, before `logImportEvent('bundle_completed', ...)` / `res.json({ results })`, add a best-effort sync. Same after the PDF loop. Import the service at the top of the file:

```typescript
import { syncTransactionEntityIds } from '../tax/services/syncTransactionEntityIds';
```

WS handler (after the `for (const file of files)` loop, before `res.json({ results })`):

```typescript
      // Re-assert txn.entity_id == account.entity_id after the whole bundle.
      // The per-row inheritance hook handles new rows, but a corp account that
      // only gets linked mid-bundle (linkWsAccountToCorpEntity) leaves earlier
      // rows on the personal default — this heals them. Best-effort: a repair
      // failure must not fail the user's import.
      try {
        await syncTransactionEntityIds(household.id);
      } catch (e) {
        logImportEvent('bundle_entity_sync_failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
```

PDF handler (same, before its `res.json({ results })`):

```typescript
    try {
      await syncTransactionEntityIds(household.id);
    } catch (e) {
      logImportEvent('pdf_bundle_entity_sync_failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
```

- [ ] **Step 2: Typecheck + full backend test run**

Run: `yarn workspace cashflow-backend typecheck`
Expected: no errors.

Run: `yarn workspace cashflow-backend test`
Expected: all green (existing + new).

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/import.ts
git commit -m "feat(import): sync transaction entity_ids after bundle import completes"
```

---

## Task 7: New idempotent corp-account reconciliation migration (supersedes the dead one)

The dead migration `20260601000001` no-ops because (a) it ran before the corp entity existed and (b) it matched `'CDG Labs Inc.'` while the importer creates `'CDG LABS INC.'`. We supersede it with a new, idempotent, **case-insensitive, name-pattern-matched** migration that self-heals on deploy and re-runs safely. We do NOT edit the already-applied migration. We do NOT hardcode account ids; we match WS corp accounts by name pattern within each household that has a corp entity.

**Files:**
- Create: `backend/src/migrations/20260602000010-reconcile-corp-account-entities.js`
- Test: `backend/test/migrations/reconcileCorpAccountEntitiesMigration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: any;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('tax_entities', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    kind: { type: DataTypes.STRING(16), allowNull: false },
    legal_name: { type: DataTypes.STRING(160), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING, allowNull: false },
    entity_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260602000010-reconcile-corp-account-entities.js');
});
after(async () => { await sequelize.close(); });

const now = new Date().toISOString();
beforeEach(async () => {
  await sequelize.query('DELETE FROM accounts');
  await sequelize.query('DELETE FROM tax_entities');
});

test('links WS corp accounts to the corp entity case-insensitively', async () => {
  const qi = sequelize.getQueryInterface();
  await qi.bulkInsert('tax_entities', [
    { id: 1, household_id: 1, kind: 'corp', legal_name: 'CDG LABS INC.', created_at: now, updated_at: now },
    { id: 2, household_id: 1, kind: 'personal', legal_name: 'Personal', created_at: now, updated_at: now },
  ]);
  await qi.bulkInsert('accounts', [
    { id: 13, household_id: 1, name: 'Wealthsimple Corporate Investing', entity_id: 2, created_at: now, updated_at: now },
    { id: 24, household_id: 1, name: 'Wealthsimple Corporate Chequing', entity_id: null, created_at: now, updated_at: now },
    { id: 50, household_id: 1, name: 'Wealthsimple TFSA', entity_id: 2, created_at: now, updated_at: now },
  ]);

  await migration.up(qi, Sequelize);

  const [rows] = await sequelize.query('SELECT id, entity_id FROM accounts ORDER BY id');
  const byId = Object.fromEntries((rows as { id: number; entity_id: number }[]).map((r) => [r.id, r.entity_id]));
  assert.equal(byId[13], 1, 'corp investing → corp entity');
  assert.equal(byId[24], 1, 'corp chequing → corp entity');
  assert.equal(byId[50], 2, 'TFSA untouched (still personal)');
});

test('is idempotent and a no-op when no corp entity exists', async () => {
  const qi = sequelize.getQueryInterface();
  await qi.bulkInsert('tax_entities', [
    { id: 2, household_id: 1, kind: 'personal', legal_name: 'Personal', created_at: now, updated_at: now },
  ]);
  await qi.bulkInsert('accounts', [
    { id: 24, household_id: 1, name: 'Wealthsimple Corporate Chequing', entity_id: null, created_at: now, updated_at: now },
  ]);
  await migration.up(qi, Sequelize); // no corp entity → no change
  let [rows] = await sequelize.query('SELECT entity_id FROM accounts WHERE id = 24');
  assert.equal((rows as { entity_id: number | null }[])[0].entity_id, null);

  // Now add corp entity and run twice; second run changes nothing further.
  await qi.bulkInsert('tax_entities', [
    { id: 1, household_id: 1, kind: 'corp', legal_name: 'CDG LABS INC.', created_at: now, updated_at: now },
  ]);
  await migration.up(qi, Sequelize);
  await migration.up(qi, Sequelize);
  [rows] = await sequelize.query('SELECT entity_id FROM accounts WHERE id = 24');
  assert.equal((rows as { entity_id: number }[])[0].entity_id, 1);
});

test('scopes per household — does not cross corp entities between households', async () => {
  const qi = sequelize.getQueryInterface();
  await qi.bulkInsert('tax_entities', [
    { id: 1, household_id: 1, kind: 'corp', legal_name: 'CDG LABS INC.', created_at: now, updated_at: now },
    { id: 3, household_id: 2, kind: 'corp', legal_name: 'Other Co Inc.', created_at: now, updated_at: now },
  ]);
  await qi.bulkInsert('accounts', [
    { id: 24, household_id: 1, name: 'Wealthsimple Corporate Chequing', entity_id: null, created_at: now, updated_at: now },
    { id: 25, household_id: 2, name: 'WS Save for Business', entity_id: null, created_at: now, updated_at: now },
  ]);
  await migration.up(qi, Sequelize);
  const [rows] = await sequelize.query('SELECT id, entity_id FROM accounts ORDER BY id');
  const byId = Object.fromEntries((rows as { id: number; entity_id: number }[]).map((r) => [r.id, r.entity_id]));
  assert.equal(byId[24], 1);
  assert.equal(byId[25], 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/migrations/reconcileCorpAccountEntitiesMigration.test.ts`
Expected: FAIL — migration module not found.

- [ ] **Step 3: Write the migration**

```javascript
'use strict';

/**
 * Idempotent, case-insensitive reconciliation of Wealthsimple corporate
 * accounts to their household's corp Entity.
 *
 * SUPERSEDES 20260601000001-link-ws-corp-accounts-cdg.js, which no-ops in prod
 * for two reasons: (a) it ran before the corp Entity existed (the Wise/RBC
 * importer auto-creates the corp 'CDG LABS INC.' on first upload), and (b) it
 * matched legal_name = 'CDG Labs Inc.' while the importer actually stores
 * 'CDG LABS INC.' (case mismatch). Because that migration is already recorded
 * in SequelizeMeta, it cannot re-run; this NEW migration fixes the gap and is
 * safe to re-run on every deploy.
 *
 * Strategy (no hardcoded account ids): for every household that HAS a corp
 * Entity, point its Wealthsimple-corp-named accounts (Corporate Investing /
 * Corporate Chequing / Save for Business) at that corp Entity when they are
 * not already linked to it. Matching is by account NAME pattern + per-household
 * corp entity — self-healing and environment-independent.
 *
 * No-op when a household has no corp Entity. Down: intentional no-op (unlinking
 * would reintroduce the bad personal mapping).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [corps] = await sequelize.query(
      `SELECT id, household_id FROM tax_entities WHERE kind = 'corp'`,
    );
    for (const corp of corps) {
      await sequelize.query(
        `UPDATE accounts
            SET entity_id = :corpId
          WHERE household_id = :hid
            AND (entity_id IS NULL OR entity_id <> :corpId)
            AND (
              lower(name) LIKE '%corporate investing%'
              OR lower(name) LIKE '%corporate chequing%'
              OR lower(name) LIKE '%save for business%'
            )`,
        { replacements: { corpId: corp.id, hid: corp.household_id } },
      );
    }
  },

  async down() {
    // intentional no-op — see header
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/migrations/reconcileCorpAccountEntitiesMigration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260602000010-reconcile-corp-account-entities.js backend/test/migrations/reconcileCorpAccountEntitiesMigration.test.ts
git commit -m "fix(migration): idempotent case-insensitive corp-account reconciliation"
```

---

## Task 8: Full verification + lint

- [ ] **Step 1: Typecheck**

Run: `yarn workspace cashflow-backend typecheck`
Expected: clean.

- [ ] **Step 2: Lint**

Run: `yarn workspace cashflow-backend lint`
Expected: clean (fix any new-file lint issues).

- [ ] **Step 3: Full backend test suite**

Run: `yarn workspace cashflow-backend test`
Expected: all green. Capture output for the PR body.

- [ ] **Step 4: Sanity — grep that no creation path is missed**

Confirm `routes/accounts.ts`, `onboarding/runOnboardingImport.ts`, both importers, and demo all flow through the Account hook (they call `Account.create` / `findOrCreate`, so they do). No code change expected.

---

## Self-Review Notes

- **Spec coverage:** Deliverable 1 (account creation sets entity_id) → Tasks 1-2. Deliverable 2 (txn inherits from account) → Task 3. Deliverable 3 (idempotent repair service + invoked at import completion) → Tasks 4 & 6. Deliverable 4 (fix dead corp-link migration, case-insensitive + idempotent, new migration) → Tasks 5 & 7.
- **Primitives spine:** No new primitive — field population on Account + Transaction. Confirmed.
- **No prod writes:** Migration is idempotent/self-healing and name-pattern matched; tests use in-memory sqlite only.
