import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260602000001-create-financial-goals.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates financial_goals table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('financial_goals'),
    `Expected financial_goals in: ${tables.join(', ')}`,
  );
});

test('financial_goals has expected columns including nullable ones', async () => {
  const description = await sequelize.getQueryInterface().describeTable('financial_goals');
  // Required NOT NULL columns
  assert.equal(description.user_id?.allowNull, false);
  assert.equal(description.household_id?.allowNull, false);
  assert.equal(description.name?.allowNull, false);
  assert.equal(description.target_amount?.allowNull, false);
  assert.equal(description.current_amount?.allowNull, false);
  assert.equal(description.currency?.allowNull, false);
  assert.equal(description.priority?.allowNull, false);
  assert.equal(description.status?.allowNull, false);
  // Nullable columns
  assert.equal(description.target_date?.allowNull, true);
  assert.equal(description.monthly_contribution?.allowNull, true);
  assert.equal(description.linked_account_id?.allowNull, true);
  assert.equal(description.notes?.allowNull, true);
});

test('financial_goals defaults current_amount to 0', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO accounts (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO financial_goals
      (household_id, user_id, name, target_amount, currency, created_at, updated_at)
    VALUES
      (1, 1, 'Emergency fund', 5000, 'CAD', datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT current_amount, priority, status FROM financial_goals WHERE name = 'Emergency fund'`,
  );
  const row = (rows as Array<{ current_amount: number | string; priority: number; status: string }>)[0];
  assert.equal(Number(row.current_amount), 0);
  assert.equal(row.priority, 0);
  assert.equal(row.status, 'active');
});

test('financial_goals supports target_date + monthly_contribution + linked_account_id', async () => {
  await sequelize.query(`
    INSERT INTO financial_goals
      (household_id, user_id, name, target_amount, current_amount, currency,
       target_date, monthly_contribution, linked_account_id, priority, status,
       created_at, updated_at)
    VALUES
      (1, 1, 'Vacation 2027', 4000, 500, 'CAD',
       '2027-06-01', 500, 1, 5, 'active',
       datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT target_date, monthly_contribution, linked_account_id, priority FROM financial_goals WHERE name = 'Vacation 2027'`,
  );
  const row = (rows as Array<{
    target_date: string;
    monthly_contribution: number | string;
    linked_account_id: number;
    priority: number;
  }>)[0];
  assert.equal(row.target_date, '2027-06-01');
  assert.equal(Number(row.monthly_contribution), 500);
  assert.equal(row.linked_account_id, 1);
  assert.equal(row.priority, 5);
});

test('financial_goals supports completed status (archive)', async () => {
  await sequelize.query(`
    INSERT INTO financial_goals
      (household_id, user_id, name, target_amount, current_amount, currency,
       status, created_at, updated_at)
    VALUES
      (1, 1, 'Old goal', 1000, 1000, 'CAD',
       'completed', datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT status, current_amount, target_amount FROM financial_goals WHERE name = 'Old goal'`,
  );
  const row = (rows as Array<{ status: string; current_amount: number | string; target_amount: number | string }>)[0];
  assert.equal(row.status, 'completed');
  assert.equal(Number(row.current_amount), Number(row.target_amount));
});

test('down drops the financial_goals table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('financial_goals'),
    `financial_goals should be gone, found: ${tables.join(', ')}`,
  );
});
