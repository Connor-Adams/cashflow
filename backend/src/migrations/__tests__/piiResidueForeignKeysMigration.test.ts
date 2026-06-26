/**
 * Round-trip test for migration 20260629000001-pii-residue-foreign-keys
 * (#868).
 *
 * The FK DDL + orphan backfill is Postgres-only (SQLite cannot ALTER TABLE
 * ADD CONSTRAINT without a full table rebuild, which the repo avoids). On the
 * SQLite unit-test DB the migration must be a safe no-op — these tests pin
 * that the dialect guard is in place (without it, ALTER TABLE ADD CONSTRAINT
 * and the backfill DELETE against not-yet-created tables would throw on
 * SQLite). The real Postgres FK + backfill behaviour is exercised by the
 * integration suite (piiResidueForeignKeys.test.ts), which runs the whole
 * migration chain against Postgres.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: any;

const now = new Date().toISOString();

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    account_id: { type: DataTypes.INTEGER, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('transaction_revisions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    transaction_id: { type: DataTypes.INTEGER, allowNull: false },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
    changes: { type: DataTypes.TEXT, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('account_statements', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    account_id: { type: DataTypes.INTEGER, allowNull: false },
    period_start: { type: DataTypes.DATEONLY, allowNull: false },
    period_end: { type: DataTypes.DATEONLY, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260629000001-pii-residue-foreign-keys.js');
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await sequelize.query('DELETE FROM transaction_revisions');
  await sequelize.query('DELETE FROM account_statements');
  await sequelize.query('DELETE FROM transactions');
  await sequelize.query('DELETE FROM accounts');
  await sequelize.query('DELETE FROM households');
});

test('up is a safe no-op on sqlite (FKs + backfill added on postgres only)', async () => {
  const qi = sequelize.getQueryInterface();
  await qi.bulkInsert('households', [{ id: 1, name: 'H', created_at: now, updated_at: now }]);
  await qi.bulkInsert('accounts', [
    { id: 5, name: 'A', household_id: 1, created_at: now, updated_at: now },
  ]);
  await qi.bulkInsert('transactions', [
    { id: 7, account_id: 5, created_at: now, updated_at: now },
  ]);
  // An intentionally-orphaned revision row (transaction_id 999 does not exist):
  // on SQLite the migration must NOT delete it (no-op), proving the backfill is
  // Postgres-guarded.
  await qi.bulkInsert('transaction_revisions', [
    { id: 11, transaction_id: 999, household_id: 1, changes: '[]', created_at: now, updated_at: now },
  ]);
  await qi.bulkInsert('account_statements', [
    {
      id: 13,
      household_id: 1,
      account_id: 5,
      period_start: '2026-01-01',
      period_end: '2026-01-31',
      created_at: now,
      updated_at: now,
    },
  ]);

  await assert.doesNotReject(() => migration.up(qi, Sequelize));

  // No-op on SQLite: even the orphan row survives, table still writable.
  const [revs] = await sequelize.query('SELECT id FROM transaction_revisions');
  assert.equal((revs as { id: number }[]).length, 1);
  const [stmts] = await sequelize.query('SELECT id FROM account_statements');
  assert.equal((stmts as { id: number }[]).length, 1);
});

test('up is idempotent on sqlite (safe to re-run)', async () => {
  const qi = sequelize.getQueryInterface();
  await assert.doesNotReject(() => migration.up(qi, Sequelize));
  await assert.doesNotReject(() => migration.up(qi, Sequelize));
});

test('down is a safe no-op on sqlite', async () => {
  await assert.doesNotReject(() => migration.down(sequelize.getQueryInterface(), Sequelize));
});
