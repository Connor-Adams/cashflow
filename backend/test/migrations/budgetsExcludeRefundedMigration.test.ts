import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mig = { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };
let excludeRefunded: Mig;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('budget_targets', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    category: { type: DataTypes.STRING(128), allowNull: true },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    period: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'monthly',
    },
    scope: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'household',
    },
    rollover_enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  // Seed a legacy row so we can prove the default backfills cleanly.
  await sequelize.query(
    `INSERT INTO budget_targets (id, household_id, category, currency, amount, period, scope, rollover_enabled, created_at, updated_at)
     VALUES (1, 1, 'Groceries', 'CAD', 400, 'monthly', 'household', 0, datetime('now'), datetime('now'))`
  );

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  excludeRefunded = require('../../src/migrations/20260602000002-budgets-exclude-refunded.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds exclude_refunded_purchases with default=false on legacy rows', async () => {
  await excludeRefunded.up(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.ok(cols.exclude_refunded_purchases, 'exclude_refunded_purchases column should exist');
  const [rows] = await sequelize.query(
    `SELECT exclude_refunded_purchases FROM budget_targets WHERE id = 1`
  );
  const row = (rows as Array<{ exclude_refunded_purchases: number }>)[0];
  // SQLite stores boolean as 0/1
  assert.equal(Number(row.exclude_refunded_purchases), 0);
});

test('down removes the column cleanly', async () => {
  await excludeRefunded.down(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.equal(cols.exclude_refunded_purchases, undefined);
});
