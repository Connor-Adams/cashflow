import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260605000001-create-financial-scenarios.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates financial_scenarios table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('financial_scenarios'),
    `Expected financial_scenarios in: ${tables.join(', ')}`,
  );
});

test('financial_scenarios has expected columns with NOT NULL constraints', async () => {
  const desc = await sequelize.getQueryInterface().describeTable('financial_scenarios');
  assert.equal(desc.user_id?.allowNull, false);
  assert.equal(desc.household_id?.allowNull, false);
  assert.equal(desc.name?.allowNull, false);
  assert.equal(desc.assumptions_json?.allowNull, false);
  assert.equal(desc.horizon_days?.allowNull, false);
  assert.equal(desc.currency?.allowNull, false);
  assert.equal(desc.created_at?.allowNull, false);
  assert.equal(desc.updated_at?.allowNull, false);
  // base_forecast_id and result_json are nullable.
  assert.equal(desc.base_forecast_id?.allowNull, true);
  assert.equal(desc.result_json?.allowNull, true);
});

test('a row can be inserted with the documented defaults', async () => {
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO financial_scenarios
      (user_id, household_id, name, assumptions_json, currency, created_at, updated_at)
    VALUES
      (1, 1, 'Baseline', '[]', 'CAD', datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT horizon_days, currency, result_json FROM financial_scenarios WHERE user_id = 1`,
  );
  const row = (rows as Array<{
    horizon_days: number;
    currency: string;
    result_json: string | null;
  }>)[0];
  assert.equal(row.horizon_days, 90);
  assert.equal(row.currency, 'CAD');
  assert.equal(row.result_json, null);
});

test('down drops the financial_scenarios table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('financial_scenarios'),
    `financial_scenarios should be gone, found: ${tables.join(', ')}`,
  );
});
