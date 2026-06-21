/**
 * Round-trip test for migration
 * 20260625100001-cashflow-settings-assumed-annual-return-rate (#654).
 *
 * Adds `assumed_annual_return_rate` (DECIMAL(5,4), NOT NULL, default 0.0500)
 * to `cashflow_settings`. In-memory SQLite: stub the parent table with the
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
  });
  // Seed a row so we can verify the default fills in correctly during up().
  await sequelize.query(
    `INSERT INTO cashflow_settings (user_id, minimum_cash_buffer) VALUES (42, 0)`,
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260625100001-cashflow-settings-assumed-annual-return-rate.js');
});

after(async () => {
  await sequelize.close();
});

test('up: adds assumed_annual_return_rate column with NOT NULL + default', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('cashflow_settings');
  assert.ok('assumed_annual_return_rate' in desc, 'assumed_annual_return_rate missing');
  assert.equal(
    desc.assumed_annual_return_rate.allowNull,
    false,
    'assumed_annual_return_rate must be NOT NULL',
  );
});

test('up: pre-existing rows get the default value 0.05', async () => {
  const [rows] = (await sequelize.query(
    `SELECT user_id, assumed_annual_return_rate FROM cashflow_settings`,
  )) as [Array<{ user_id: number; assumed_annual_return_rate: number }>, unknown];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 42);
  assert.equal(Number(rows[0].assumed_annual_return_rate), 0.05);
});

test('assumed_annual_return_rate accepts custom decimals in-range', async () => {
  await sequelize.query(
    `UPDATE cashflow_settings SET assumed_annual_return_rate = 0.08 WHERE user_id = 42`,
  );
  const [rows] = (await sequelize.query(
    `SELECT assumed_annual_return_rate FROM cashflow_settings WHERE user_id = 42`,
  )) as [Array<{ assumed_annual_return_rate: number }>, unknown];
  assert.equal(Number(rows[0].assumed_annual_return_rate), 0.08);
});

test('down: removes the column cleanly', async () => {
  await sequelize.query(
    `UPDATE cashflow_settings SET assumed_annual_return_rate = 0.05 WHERE user_id = 42`,
  );
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('cashflow_settings');
  assert.ok(
    !('assumed_annual_return_rate' in desc),
    'assumed_annual_return_rate should be removed',
  );
});

test('down: untouched data survives', async () => {
  const [rows] = (await sequelize.query(
    `SELECT user_id, minimum_cash_buffer FROM cashflow_settings`,
  )) as [Array<{ user_id: number; minimum_cash_buffer: number }>, unknown];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 42);
});
