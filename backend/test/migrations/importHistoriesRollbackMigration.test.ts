/**
 * Round-trip test for migration 20260603000010-import-histories-rollback
 * (#233). Spins up an in-memory SQLite DB, stubs a minimal
 * `import_histories` table with only the columns Sequelize needs for
 * addColumn, runs up, asserts the new rollback columns exist and accept the
 * expected payload, then runs down and confirms cleanup.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Minimal import_histories stub. Only `id` and `status` are required for
  // the rollback flow; the migration adds the two new columns against this
  // table.
  await sequelize.getQueryInterface().createTable('import_histories', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'completed' },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260603000010-import-histories-rollback.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds rolled_back_at + rolled_back_by_user_id columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('import_histories');
  assert.ok(desc.rolled_back_at, 'expected rolled_back_at column');
  assert.ok(
    desc.rolled_back_by_user_id,
    'expected rolled_back_by_user_id column',
  );
  // Both NULL by default — backward compatible with existing rows.
  assert.equal(desc.rolled_back_at.allowNull, true);
  assert.equal(desc.rolled_back_by_user_id.allowNull, true);
});

test('columns accept a rollback marker payload', async () => {
  await sequelize.query(
    `INSERT INTO import_histories (id, status, rolled_back_at, rolled_back_by_user_id)
     VALUES (1, 'rolled_back', '2026-05-26 12:00:00', 42)`,
  );
  await sequelize.query(
    `INSERT INTO import_histories (id, status, rolled_back_at, rolled_back_by_user_id)
     VALUES (2, 'completed', NULL, NULL)`,
  );
  const rows = await sequelize.query<{
    id: number;
    status: string;
    rolled_back_at: string | null;
    rolled_back_by_user_id: number | null;
  }>(
    `SELECT id, status, rolled_back_at, rolled_back_by_user_id FROM import_histories ORDER BY id`,
    { type: 'SELECT' as never },
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'rolled_back');
  assert.equal(rows[0].rolled_back_by_user_id, 42);
  assert.ok(rows[0].rolled_back_at, 'rolled_back_at should be persisted');
  assert.equal(rows[1].status, 'completed');
  assert.equal(rows[1].rolled_back_at, null);
});

test('down drops both columns cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('import_histories');
  assert.equal(
    desc.rolled_back_at,
    undefined,
    'rolled_back_at column should be gone',
  );
  assert.equal(
    desc.rolled_back_by_user_id,
    undefined,
    'rolled_back_by_user_id column should be gone',
  );
});
