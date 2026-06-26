/**
 * Integration tests for the PII-residue FK hardening (#868). These run the
 * full migration chain against a real Postgres (see _setup/pgTestDb) because
 * the FKs + orphan backfill are Postgres-only — on SQLite the migration is a
 * no-op (mirrors 20260618000001-entity-id-foreign-keys), so the DB-level
 * cascade cannot be exercised there.
 *
 * Seeding goes through the Sequelize models (not raw INSERT) so the
 * beforeCreate hooks fill accounts.entity_id / transactions.entity_id — those
 * columns are NOT NULL on Postgres (20260619000001-entity-id-not-null) and a
 * raw INSERT that omits them is rejected (mirrors entityIdNotNull.test.ts).
 *
 * Proves:
 *   1. transaction_revisions.transaction_id is a real FK ON DELETE CASCADE:
 *      bulk `DELETE FROM transactions` (the path account-delete actually uses)
 *      cascades the revision rows away — no PII residue.
 *   2. account_statements.account_id is a real FK ON DELETE CASCADE: deleting
 *      an account cascades its statements away.
 *   3. account_statements.household_id is a real FK ON DELETE CASCADE:
 *      deleting a household cascades its statements away.
 *   4. inserting a revision / statement with a dangling parent id is rejected
 *      at the DB layer (referential integrity now exists).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { QueryTypes } from 'sequelize';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let models: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sequelize: any;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('pii_residue_fks');
  models = await import('../../src/models');
  sequelize = models.sequelize;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

/** Seed household + account via the models so the beforeCreate hooks fill the
 *  NOT NULL entity_id column. No transaction — used by the statement-cascade
 *  tests, which delete the account/household directly (a lingering transaction
 *  would block the account delete via transactions.account_id RESTRICT). */
async function seedAccount(label: string): Promise<{
  householdId: number;
  accountId: number;
}> {
  const household = await models.Household.create({ name: `${label} hh` });
  const account = await models.Account.create({
    householdId: household.id,
    ownerUserId: null,
    owner: 'me',
    visibility: 'private',
    name: `${label} acct`,
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: null,
  });
  return { householdId: household.id, accountId: account.id };
}

/** seedAccount + a transaction (entity_id filled by the txn hook). */
async function seed(label: string): Promise<{
  householdId: number;
  accountId: number;
  transactionId: number;
}> {
  const { householdId, accountId } = await seedAccount(label);
  const txn = await models.Transaction.create({
    accountId,
    householdId,
    importBatch: 'pii-fk-test',
    date: '2026-01-15',
    merchantRaw: 'Coffee Co',
    merchantClean: 'Coffee Co',
    amount: '4.50',
    currency: 'CAD',
    sourceRowFingerprint: `fp-${crypto.randomBytes(8).toString('hex')}`,
    sourceIdentityFingerprint: `id-${crypto.randomBytes(8).toString('hex')}`,
    finalCategory: 'Food',
  });
  return { householdId, accountId, transactionId: txn.id };
}

async function insertRevision(transactionId: number, householdId: number): Promise<void> {
  await models.TransactionRevision.create({
    transactionId,
    householdId,
    source: 'user_edit',
    changes: JSON.stringify([{ field: 'merchantClean', before: 'Coffee Co', after: 'Cafe' }]),
  });
}

async function insertStatement(accountId: number, householdId: number): Promise<void> {
  await models.AccountStatement.create({
    householdId,
    accountId,
    visibility: 'shared',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    openingBalance: '1000.0000',
    closingBalance: '950.0000',
    currency: 'CAD',
  });
}

async function countRevisions(transactionId: number): Promise<number> {
  const rows = await sequelize.query(
    'SELECT COUNT(*)::int AS n FROM transaction_revisions WHERE transaction_id = :tid',
    { replacements: { tid: transactionId }, type: QueryTypes.SELECT },
  );
  return rows[0].n;
}

async function countStatements(accountId: number): Promise<number> {
  const rows = await sequelize.query(
    'SELECT COUNT(*)::int AS n FROM account_statements WHERE account_id = :aid',
    { replacements: { aid: accountId }, type: QueryTypes.SELECT },
  );
  return rows[0].n;
}

test('bulk DELETE FROM transactions cascades transaction_revisions away (no PII residue)', async () => {
  const { householdId, accountId, transactionId } = await seed('rev-cascade');
  await insertRevision(transactionId, householdId);
  assert.equal(await countRevisions(transactionId), 1, 'revision seeded');

  // The exact path account-delete uses: bulk delete by accountId, NOT instance
  // .destroy(), so the JS hooks:true cascade never fires — only the DB FK can.
  await sequelize.query('DELETE FROM transactions WHERE account_id = :aid', {
    replacements: { aid: accountId },
    type: QueryTypes.DELETE,
  });
  assert.equal(await countRevisions(transactionId), 0, 'revision rows must be cascaded, not orphaned');
});

test('deleting an account cascades its account_statements away (via account_id FK)', async () => {
  const { householdId, accountId } = await seedAccount('stmt-acct-cascade');
  await insertStatement(accountId, householdId);
  assert.equal(await countStatements(accountId), 1, 'statement seeded');

  await sequelize.query('DELETE FROM accounts WHERE id = :aid', {
    replacements: { aid: accountId },
    type: QueryTypes.DELETE,
  });
  assert.equal(await countStatements(accountId), 0, 'statement rows must be cascaded on account delete');
});

test('deleting a household cascades its account_statements away (via household_id FK)', async () => {
  const { householdId, accountId } = await seedAccount('stmt-hh-cascade');
  await insertStatement(accountId, householdId);
  assert.equal(await countStatements(accountId), 1, 'statement seeded');

  await sequelize.query('DELETE FROM households WHERE id = :hid', {
    replacements: { hid: householdId },
    type: QueryTypes.DELETE,
  });
  assert.equal(await countStatements(accountId), 0, 'statement rows must be cascaded on household delete');
});

test('inserting a transaction_revision with a dangling transaction_id is rejected', async () => {
  const now = new Date().toISOString();
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO transaction_revisions
           (transaction_id, household_id, source, changes, created_at, updated_at)
         VALUES (2147483000, 1, 'user_edit', '[]', :now, :now)`,
        { replacements: { now }, type: QueryTypes.INSERT },
      ),
    /foreign key constraint/i,
    'a revision pointing at a non-existent transaction must be refused at the DB',
  );
});

test('inserting an account_statement with a dangling account_id is rejected', async () => {
  const { householdId } = await seedAccount('stmt-fk-reject');
  const now = new Date().toISOString();
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO account_statements
           (household_id, account_id, visibility, period_start, period_end,
            opening_balance, closing_balance, currency, created_at, updated_at)
         VALUES (:hid, 2147483000, 'shared', '2026-01-01', '2026-01-31',
            '0', '0', 'CAD', :now, :now)`,
        { replacements: { hid: householdId, now }, type: QueryTypes.INSERT },
      ),
    /foreign key constraint/i,
    'a statement pointing at a non-existent account must be refused at the DB',
  );
});
