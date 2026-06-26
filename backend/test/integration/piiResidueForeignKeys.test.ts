/**
 * Integration tests for the PII-residue FK hardening (#868). These run the
 * full migration chain against a real Postgres (see _setup/pgTestDb) because
 * the FKs + orphan backfill are Postgres-only — on SQLite the migration is a
 * no-op (mirrors 20260618000001-entity-id-foreign-keys), so the DB-level
 * cascade cannot be exercised there.
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
let sequelize: any;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('pii_residue_fks');
  const mod = await import('../../src/db.js');
  sequelize = mod.sequelize;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

const now = new Date().toISOString();

/** Seed a household + account + transaction via raw SQL; returns their ids. */
async function seed(label: string): Promise<{
  householdId: number;
  accountId: number;
  transactionId: number;
}> {
  const [hh] = await sequelize.query(
    'INSERT INTO households (name, created_at, updated_at) VALUES (:name, :now, :now) RETURNING id',
    { replacements: { name: `${label} hh`, now }, type: QueryTypes.SELECT },
  );
  const householdId = hh.id;

  const [acct] = await sequelize.query(
    `INSERT INTO accounts (name, household_id, account_type, default_currency, visibility, owner, created_at, updated_at)
     VALUES (:name, :hid, 'checking', 'CAD', 'private', 'me', :now, :now) RETURNING id`,
    { replacements: { name: `${label} acct`, hid: householdId, now }, type: QueryTypes.SELECT },
  );
  const accountId = acct.id;

  const [txn] = await sequelize.query(
    `INSERT INTO transactions
       (account_id, household_id, import_batch, date, merchant_raw, merchant_clean,
        amount, currency, source_row_fingerprint, source_identity_fingerprint, final_category,
        created_at, updated_at)
     VALUES (:aid, :hid, 'pii-fk-test', '2026-01-15', 'Coffee Co', 'Coffee Co',
        '4.50', 'CAD', :rfp, :ifp, 'Food', :now, :now) RETURNING id`,
    {
      replacements: {
        aid: accountId,
        hid: householdId,
        rfp: `fp-${crypto.randomBytes(8).toString('hex')}`,
        ifp: `id-${crypto.randomBytes(8).toString('hex')}`,
        now,
      },
      type: QueryTypes.SELECT,
    },
  );
  return { householdId, accountId, transactionId: txn.id };
}

async function insertRevision(transactionId: number, householdId: number): Promise<void> {
  await sequelize.query(
    `INSERT INTO transaction_revisions
       (transaction_id, household_id, source, changes, created_at, updated_at)
     VALUES (:tid, :hid, 'user_edit', :changes, :now, :now)`,
    {
      replacements: {
        tid: transactionId,
        hid: householdId,
        changes: JSON.stringify([{ field: 'merchantClean', before: 'Coffee Co', after: 'Cafe' }]),
        now,
      },
      type: QueryTypes.INSERT,
    },
  );
}

async function insertStatement(accountId: number, householdId: number): Promise<void> {
  await sequelize.query(
    `INSERT INTO account_statements
       (household_id, account_id, visibility, period_start, period_end,
        opening_balance, closing_balance, currency, created_at, updated_at)
     VALUES (:hid, :aid, 'shared', '2026-01-01', '2026-01-31',
        '1000.0000', '950.0000', 'CAD', :now, :now)`,
    { replacements: { hid: householdId, aid: accountId, now }, type: QueryTypes.INSERT },
  );
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
  const { householdId, accountId } = await seed('stmt-acct-cascade');
  await insertStatement(accountId, householdId);
  assert.equal(await countStatements(accountId), 1, 'statement seeded');

  await sequelize.query('DELETE FROM accounts WHERE id = :aid', {
    replacements: { aid: accountId },
    type: QueryTypes.DELETE,
  });
  assert.equal(await countStatements(accountId), 0, 'statement rows must be cascaded on account delete');
});

test('deleting a household cascades its account_statements away (via household_id FK)', async () => {
  const { householdId, accountId } = await seed('stmt-hh-cascade');
  await insertStatement(accountId, householdId);
  assert.equal(await countStatements(accountId), 1, 'statement seeded');

  await sequelize.query('DELETE FROM households WHERE id = :hid', {
    replacements: { hid: householdId },
    type: QueryTypes.DELETE,
  });
  assert.equal(await countStatements(accountId), 0, 'statement rows must be cascaded on household delete');
});

test('inserting a transaction_revision with a dangling transaction_id is rejected', async () => {
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
  const { householdId } = await seed('stmt-fk-reject');
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
