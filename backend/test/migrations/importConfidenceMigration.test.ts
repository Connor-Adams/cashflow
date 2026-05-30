/**
 * Round-trip test for migration 20260603000001-transactions-import-confidence
 * (#214). Spins up an in-memory SQLite DB, stubs a minimal `transactions`
 * table (with only the columns Sequelize needs for addColumn / addIndex),
 * runs up, asserts the columns + index are present, then runs down and
 * confirms cleanup.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Minimal transactions stub. Only `id` is required; the migration adds the
  // two new columns + index against this table.
  await sequelize.getQueryInterface().createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260603000001-transactions-import-confidence.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds import_confidence + import_confidence_flags columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok(desc.import_confidence, 'expected import_confidence column');
  assert.ok(
    desc.import_confidence_flags,
    'expected import_confidence_flags column',
  );
  // NULL by default — backward compatible.
  assert.equal(desc.import_confidence.allowNull, true);
  assert.equal(desc.import_confidence_flags.allowNull, true);
});

test('up adds the transactions_import_confidence index', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('transactions');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('transactions_import_confidence'),
    `expected index, got: ${names.join(', ')}`,
  );
});

test('column accepts the documented enum values', async () => {
  await sequelize.query(
    `INSERT INTO transactions (id, import_confidence, import_confidence_flags)
     VALUES (1, 'clean', NULL)`,
  );
  await sequelize.query(
    `INSERT INTO transactions (id, import_confidence, import_confidence_flags)
     VALUES (2, 'needs_review', '["needs_review","missing_category"]')`,
  );
  const rows = await sequelize.query<{ id: number; import_confidence: string | null; import_confidence_flags: string | null }>(
    `SELECT id, import_confidence, import_confidence_flags FROM transactions ORDER BY id`,
    { type: 'SELECT' as never },
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].import_confidence, 'clean');
  assert.equal(rows[1].import_confidence, 'needs_review');
  assert.equal(rows[1].import_confidence_flags, '["needs_review","missing_category"]');
});

test('down drops the index and both columns cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('transactions');
  assert.equal(
    desc.import_confidence,
    undefined,
    'import_confidence column should be gone',
  );
  assert.equal(
    desc.import_confidence_flags,
    undefined,
    'import_confidence_flags column should be gone',
  );
  const indexes = await sequelize.getQueryInterface().showIndex('transactions');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    !names.includes('transactions_import_confidence'),
    `index should be gone, got: ${names.join(', ')}`,
  );
});
