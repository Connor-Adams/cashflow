/**
 * Round-trip test for the subscriptions migration (Cashflow #205).
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
  migration = require('../20260530000002-subscriptions.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates subscriptions table with expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(tables.includes('subscriptions'), `Expected table in: ${tables.join(', ')}`);

  const desc = await sequelize.getQueryInterface().describeTable('subscriptions');
  assert.ok(desc.id, 'has id');
  assert.ok(desc.household_id, 'has household_id');
  assert.ok(desc.merchant_name, 'has merchant_name');
  assert.ok(desc.normalized_name, 'has normalized_name');
  assert.ok(desc.amount, 'has amount');
  assert.ok(desc.currency, 'has currency');
  assert.ok(desc.cadence, 'has cadence');
  assert.ok(desc.last_charge_date, 'has last_charge_date');
  assert.ok(desc.next_expected_date, 'has next_expected_date');
  assert.ok(desc.status, 'has status');
  assert.ok(desc.category, 'has category');
  assert.ok(desc.annualized_cost, 'has annualized_cost');
  assert.ok(desc.price_change_detected, 'has price_change_detected');
  assert.ok(desc.cancellation_url, 'has cancellation_url');
  assert.ok(desc.notes, 'has notes');
});

test('enforces UNIQUE (household_id, normalized_name, currency)', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO subscriptions
      (household_id, merchant_name, normalized_name, amount, currency, cadence,
       last_charge_date, next_expected_date, status, annualized_cost,
       price_change_detected, created_at, updated_at)
    VALUES (1, 'Netflix', 'netflix', 15.99, 'CAD', 'monthly',
            '2026-04-05', '2026-05-05', 'active', 191.88,
            0, datetime('now'), datetime('now'))
  `);
  await assert.rejects(
    () =>
      sequelize.query(`
        INSERT INTO subscriptions
          (household_id, merchant_name, normalized_name, amount, currency, cadence,
           last_charge_date, next_expected_date, status, annualized_cost,
           price_change_detected, created_at, updated_at)
        VALUES (1, 'Netflix', 'netflix', 17.99, 'CAD', 'monthly',
                '2026-05-05', '2026-06-05', 'active', 215.88,
                0, datetime('now'), datetime('now'))
      `),
    (err: Error) => {
      assert.ok(err instanceof Error, 'Should throw an Error');
      return true;
    },
  );
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(!tables.includes('subscriptions'), `Table should be gone, found: ${tables.join(', ')}`);
});
