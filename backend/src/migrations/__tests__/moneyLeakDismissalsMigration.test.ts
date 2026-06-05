/**
 * Round-trip test for the money_leak_dismissals migration (Cashflow #220).
 * Creates the table on an in-memory SQLite, asserts the schema, then rolls
 * it back and confirms the table is gone.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260602100000-money-leak-dismissals.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates money_leak_dismissals table with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('money_leak_dismissals'),
    `Expected table in: ${tables.join(', ')}`,
  );

  const desc = await sequelize
    .getQueryInterface()
    .describeTable('money_leak_dismissals');
  assert.ok(desc.id, 'has id');
  assert.ok(desc.household_id, 'has household_id');
  assert.ok(desc.leak_type, 'has leak_type');
  assert.ok(desc.identity_key, 'has identity_key');
  assert.ok(desc.snapshot, 'has snapshot');
  assert.ok(desc.dismissed_by_user_id, 'has dismissed_by_user_id');
  assert.ok(desc.created_at, 'has created_at');
  assert.ok(desc.updated_at, 'has updated_at');
});

test('enforces UNIQUE (household_id, leak_type, identity_key)', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO money_leak_dismissals
      (household_id, leak_type, identity_key, created_at, updated_at)
    VALUES (1, 'small_subscription', '42', datetime('now'), datetime('now'))
  `);
  await assert.rejects(
    () =>
      sequelize.query(`
        INSERT INTO money_leak_dismissals
          (household_id, leak_type, identity_key, created_at, updated_at)
        VALUES (1, 'small_subscription', '42', datetime('now'), datetime('now'))
      `),
    (err: Error) => {
      assert.ok(err instanceof Error, 'Should throw an Error');
      return true;
    },
  );
});

test('allows different identity_keys for same household + leak_type', async () => {
  // Should NOT throw — different keys under the same (household, type).
  await sequelize.query(`
    INSERT INTO money_leak_dismissals
      (household_id, leak_type, identity_key, created_at, updated_at)
    VALUES (1, 'small_subscription', '43', datetime('now'), datetime('now'))
  `);
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('money_leak_dismissals'),
    `Table should be gone, found: ${tables.join(', ')}`,
  );
});
