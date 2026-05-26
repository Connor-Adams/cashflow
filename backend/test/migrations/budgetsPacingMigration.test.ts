import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mig = { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };
let budgetCols: Mig;
let budgetExclusions: Mig;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Minimal precursor tables so the migrations' FKs are valid.
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await sequelize.getQueryInterface().createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
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
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO budget_targets (id, household_id, category, currency, amount, period, created_at, updated_at)
     VALUES (1, 1, 'Groceries', 'CAD', 400, 'monthly', datetime('now'), datetime('now'))`
  );
  await sequelize.query(`INSERT INTO transactions (id) VALUES (101)`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  budgetCols = require('../../src/migrations/20260531000001-budgets-scope-rollover.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  budgetExclusions = require('../../src/migrations/20260531000002-budget-exclusions.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds scope and rollover_enabled columns with safe defaults', async () => {
  await budgetCols.up(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.ok(cols.scope, 'scope column should exist');
  assert.ok(cols.rollover_enabled, 'rollover_enabled column should exist');

  // Existing row should have been backfilled to scope='household'
  const [rows] = await sequelize.query(
    `SELECT scope, rollover_enabled FROM budget_targets WHERE id = 1`
  );
  const row = (rows as Array<{ scope: string; rollover_enabled: number }>)[0];
  assert.equal(row.scope, 'household');
  // SQLite stores boolean as 0/1
  assert.equal(Number(row.rollover_enabled), 0);
});

test('up creates budget_exclusions table with FK + unique constraint', async () => {
  await budgetExclusions.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('budget_exclusions'),
    `Expected budget_exclusions in: ${tables.join(', ')}`
  );

  await sequelize.query(
    `INSERT INTO budget_exclusions (budget_id, transaction_id, created_at, updated_at)
     VALUES (1, 101, datetime('now'), datetime('now'))`
  );

  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO budget_exclusions (budget_id, transaction_id, created_at, updated_at)
         VALUES (1, 101, datetime('now'), datetime('now'))`
      ),
    (err: Error) => {
      assert.ok(err instanceof Error, 'Should throw an Error');
      return true;
    }
  );
});

test('down drops budget_exclusions cleanly', async () => {
  await budgetExclusions.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('budget_exclusions'),
    `Table should be gone, found: ${tables.join(', ')}`
  );
});

test('down removes scope and rollover_enabled columns', async () => {
  await budgetCols.down(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.equal(cols.scope, undefined);
  assert.equal(cols.rollover_enabled, undefined);
});
