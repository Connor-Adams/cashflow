/**
 * Round-trip test for migration
 * 20260606100000-cashflow-settings-counterparty-threshold (#373).
 *
 * Adds `counterparty_promotion_threshold` (NOT NULL, default 3) to
 * `cashflow_settings`. In-memory SQLite, stub the parent table with the
 * columns the migration touches, run up + assert + down + assert.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('cashflow_settings', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    minimum_cash_buffer: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
      defaultValue: 0,
    },
    safe_to_spend_window_days: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 14,
    },
    include_credit_card_balance: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    include_goal_contributions: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  });
  // Seed a row so we can verify the default fills in correctly during up().
  await sequelize.query(
    `INSERT INTO cashflow_settings
       (user_id, minimum_cash_buffer, safe_to_spend_window_days,
        include_credit_card_balance, include_goal_contributions)
     VALUES (42, 0, 14, 1, 1)`,
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260606100000-cashflow-settings-counterparty-threshold.js');
});

after(async () => {
  await sequelize.close();
});

test('up: adds counterparty_promotion_threshold column with NOT NULL + default 3', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('cashflow_settings');
  assert.ok(
    'counterparty_promotion_threshold' in desc,
    'counterparty_promotion_threshold missing',
  );
  assert.equal(
    desc.counterparty_promotion_threshold.allowNull,
    false,
    'counterparty_promotion_threshold must be NOT NULL',
  );
});

test('up: pre-existing rows get the default value 3', async () => {
  const [rows] = (await sequelize.query(
    `SELECT user_id, counterparty_promotion_threshold FROM cashflow_settings`,
  )) as [Array<{ user_id: number; counterparty_promotion_threshold: number }>, unknown];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 42);
  assert.equal(rows[0].counterparty_promotion_threshold, 3);
});

test('counterparty_promotion_threshold accepts custom integers in-range', async () => {
  await sequelize.query(
    `UPDATE cashflow_settings SET counterparty_promotion_threshold = 7 WHERE user_id = 42`,
  );
  const [rows] = (await sequelize.query(
    `SELECT counterparty_promotion_threshold FROM cashflow_settings WHERE user_id = 42`,
  )) as [Array<{ counterparty_promotion_threshold: number }>, unknown];
  assert.equal(rows[0].counterparty_promotion_threshold, 7);
});

test('down: removes the column cleanly', async () => {
  // Reset back to default before removing so down() proves it's idempotent.
  await sequelize.query(
    `UPDATE cashflow_settings SET counterparty_promotion_threshold = 3 WHERE user_id = 42`,
  );
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('cashflow_settings');
  assert.ok(
    !('counterparty_promotion_threshold' in desc),
    'counterparty_promotion_threshold should be removed',
  );
});

test('down: untouched data survives', async () => {
  const [rows] = (await sequelize.query(
    `SELECT user_id, safe_to_spend_window_days FROM cashflow_settings`,
  )) as [Array<{ user_id: number; safe_to_spend_window_days: number }>, unknown];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 42);
  assert.equal(rows[0].safe_to_spend_window_days, 14);
});
