/**
 * Round-trip test for the financial_goals version migration (issue #845).
 *
 * `up` adds `financial_goals.version` (NOT NULL, default 0); `down` removes it.
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

  // Minimal financial_goals table with one pre-existing row, so we can prove
  // the new column's default backfills existing data.
  await sequelize.query(
    `CREATE TABLE financial_goals (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id INTEGER NOT NULL,
       household_id INTEGER NOT NULL,
       name TEXT NOT NULL,
       target_amount DECIMAL(14,4) NOT NULL,
       current_amount DECIMAL(14,4) NOT NULL DEFAULT 0,
       currency TEXT NOT NULL,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  await sequelize.query(
    `INSERT INTO financial_goals
       (user_id, household_id, name, target_amount, current_amount, currency, created_at, updated_at)
     VALUES (1, 1, 'Emergency fund', 5000, 1000, 'CAD', datetime('now'), datetime('now'))`,
  );

  migration = require('../20260629000001-financial-goals-version.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds version (default 0) and backfills existing rows', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('financial_goals');
  assert.ok(desc.version, 'version column added');

  const [rows] = await sequelize.query(
    'SELECT version FROM financial_goals WHERE id = 1',
  );
  const value = (rows as Array<{ version: unknown }>)[0].version;
  assert.equal(Number(value), 0, 'existing row backfilled to version 0');
});

test('down removes version', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('financial_goals');
  assert.equal(desc.version, undefined, 'version removed');
});

test('up again after down is a clean idempotent round-trip', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('financial_goals');
  assert.ok(desc.version, 're-added version');
});
