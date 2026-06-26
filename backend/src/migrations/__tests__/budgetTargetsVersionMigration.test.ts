/**
 * Round-trip test for the budget_targets version migration (issue #848).
 *
 * `up` adds `budget_targets.version` (NOT NULL, default 0); `down` removes it.
 * Default 0 backfills every existing row so optimistic locking can engage
 * immediately. Runs on in-memory SQLite (auto-discovered unit test); the
 * single dialect-portable addColumn runs verbatim on Postgres in prod.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

let sequelize: Sequelize;
let migration: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up: (...args: any[]) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  down: (...args: any[]) => Promise<void>;
};

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });

  // Minimal budget_targets table with one pre-existing row, so we can prove
  // the new column's default backfills existing data.
  await sequelize.query(
    `CREATE TABLE budget_targets (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       household_id INTEGER NOT NULL,
       category TEXT,
       currency TEXT NOT NULL,
       amount DECIMAL(14,4) NOT NULL,
       scope TEXT NOT NULL DEFAULT 'household',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  await sequelize.query(
    `INSERT INTO budget_targets
       (household_id, category, currency, amount, scope, created_at, updated_at)
     VALUES (1, 'Travel', 'CAD', 500, 'household', datetime('now'), datetime('now'))`,
  );

  migration = require('../20260626000001-budget-targets-version.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds version (default 0) and backfills existing rows', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.ok(desc.version, 'version column added');

  const [rows] = await sequelize.query(
    'SELECT version FROM budget_targets WHERE id = 1',
  );
  const value = (rows as Array<{ version: unknown }>)[0].version;
  assert.equal(Number(value), 0, 'existing row backfilled to version 0');
});

test('down removes version', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.equal(desc.version, undefined, 'version removed');
});

test('up again after down is a clean idempotent round-trip', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.ok(desc.version, 're-added version');
});
