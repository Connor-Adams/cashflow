/**
 * Round-trip test for migration
 * 20260603000007-import-batches-account-profile-counts (#231).
 *
 * Spins up an in-memory SQLite DB, stubs the minimum `accounts` +
 * `import_histories` tables the migration touches, runs up, asserts the new
 * columns + index are present, then runs down and confirms cleanup.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Stub `accounts` (the new account_id FK references it).
  await sequelize.getQueryInterface().createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // Stub `import_histories` with just enough columns that the migration's
  // addColumn/addIndex calls succeed. Mirrors how the production schema
  // already has household_id + started_at by the time this migration runs.
  await sequelize.getQueryInterface().createTable('import_histories', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260603000007-import-batches-account-profile-counts.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds account_id, profile_id and count columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('import_histories');
  assert.ok(desc.account_id, 'expected account_id column');
  assert.ok(desc.profile_id, 'expected profile_id column');
  assert.ok(desc.inserted_count, 'expected inserted_count column');
  assert.ok(desc.skipped_duplicate_count, 'expected skipped_duplicate_count column');
  assert.ok(desc.row_errors_count, 'expected row_errors_count column');
  // All NULL-safe so legacy rows stay valid.
  assert.equal(desc.account_id.allowNull, true);
  assert.equal(desc.profile_id.allowNull, true);
  assert.equal(desc.inserted_count.allowNull, true);
  assert.equal(desc.skipped_duplicate_count.allowNull, true);
  assert.equal(desc.row_errors_count.allowNull, true);
});

test('up adds the import_histories_household_started_at index', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('import_histories');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('import_histories_household_started_at'),
    `expected index, got: ${names.join(', ')}`,
  );
});

test('column accepts batch metadata payloads', async () => {
  // INSERT minimum required + new fields so we know the column types accept
  // the runtime values we'll send.
  await sequelize.query(
    `INSERT INTO import_histories (id, started_at, account_id, profile_id, inserted_count, skipped_duplicate_count, row_errors_count)
     VALUES (1, '2026-06-03 12:00:00', NULL, 'generic_simple', 5, 2, 0)`,
  );
  await sequelize.query(
    `INSERT INTO import_histories (id, started_at, account_id, profile_id, inserted_count, skipped_duplicate_count, row_errors_count)
     VALUES (2, '2026-06-03 12:00:01', NULL, NULL, NULL, NULL, NULL)`,
  );
  const rows = await sequelize.query<{
    id: number;
    account_id: number | null;
    profile_id: string | null;
    inserted_count: number | null;
    skipped_duplicate_count: number | null;
    row_errors_count: number | null;
  }>(
    `SELECT id, account_id, profile_id, inserted_count, skipped_duplicate_count, row_errors_count
     FROM import_histories ORDER BY id`,
    { type: 'SELECT' as never },
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].profile_id, 'generic_simple');
  assert.equal(rows[0].inserted_count, 5);
  assert.equal(rows[0].skipped_duplicate_count, 2);
  assert.equal(rows[0].row_errors_count, 0);
  // Legacy row stays NULL across all new columns.
  assert.equal(rows[1].profile_id, null);
  assert.equal(rows[1].inserted_count, null);
  assert.equal(rows[1].skipped_duplicate_count, null);
});

test('down drops the index and all new columns cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('import_histories');
  assert.equal(desc.account_id, undefined, 'account_id should be gone');
  assert.equal(desc.profile_id, undefined, 'profile_id should be gone');
  assert.equal(desc.inserted_count, undefined, 'inserted_count should be gone');
  assert.equal(
    desc.skipped_duplicate_count,
    undefined,
    'skipped_duplicate_count should be gone',
  );
  assert.equal(desc.row_errors_count, undefined, 'row_errors_count should be gone');
  const indexes = await sequelize.getQueryInterface().showIndex('import_histories');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    !names.includes('import_histories_household_started_at'),
    `index should be gone, got: ${names.join(', ')}`,
  );
});
