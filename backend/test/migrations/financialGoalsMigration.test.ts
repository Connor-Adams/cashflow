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
  migration = require('../../src/migrations/20260602000001-create-financial-goals.js');
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
  // Required NOT NULL
  assert.equal(description.user_id?.allowNull, false);
  assert.equal(description.household_id?.allowNull, false);
  assert.equal(description.name?.allowNull, false);
  assert.equal(description.target_amount?.allowNull, false);
  assert.equal(description.current_amount?.allowNull, false);
  assert.equal(description.currency?.allowNull, false);
  assert.equal(description.priority?.allowNull, false);
  assert.equal(description.status?.allowNull, false);
  // Nullable
  assert.equal(description.target_date?.allowNull, true);
  assert.equal(description.monthly_contribution?.allowNull, true);
  assert.equal(description.linked_account_id?.allowNull, true);
  assert.equal(description.notes?.allowNull, true);
});

test('financial_goals supports a minimal active goal', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO accounts (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO financial_goals
      (household_id, user_id, name, target_amount, current_amount, currency,
       target_date, monthly_contribution, linked_account_id, priority, status,
       notes, created_at, updated_at)
    VALUES
      (1, 1, 'Emergency fund', 10000, 0, 'CAD',
       NULL, NULL, NULL, 0, 'active',
       NULL, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT name, target_amount, current_amount, status, priority FROM financial_goals WHERE name = 'Emergency fund'`,
  );
  const row = (rows as Array<{ name: string; target_amount: string; current_amount: string; status: string; priority: number }>)[0];
  assert.equal(row.name, 'Emergency fund');
  assert.equal(Number(row.target_amount), 10000);
  assert.equal(Number(row.current_amount), 0);
  assert.equal(row.status, 'active');
  assert.equal(row.priority, 0);
});

test('financial_goals supports a fully-populated goal with linked account and target date', async () => {
  await sequelize.query(`
    INSERT INTO financial_goals
      (household_id, user_id, name, target_amount, current_amount, currency,
       target_date, monthly_contribution, linked_account_id, priority, status,
       notes, created_at, updated_at)
    VALUES
      (1, 1, 'Vacation', 5000, 1200, 'USD',
       '2027-06-01', 300, 1, 2, 'active',
       'Family trip to Hawaii', datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT target_date, monthly_contribution, linked_account_id, priority, notes, currency
       FROM financial_goals WHERE name = 'Vacation'`,
  );
  const row = (rows as Array<{
    target_date: string;
    monthly_contribution: string;
    linked_account_id: number;
    priority: number;
    notes: string;
    currency: string;
  }>)[0];
  assert.equal(row.target_date, '2027-06-01');
  assert.equal(Number(row.monthly_contribution), 300);
  assert.equal(row.linked_account_id, 1);
  assert.equal(row.priority, 2);
  assert.equal(row.notes, 'Family trip to Hawaii');
  assert.equal(row.currency, 'USD');
});

test('financial_goals supports a completed (archived) goal', async () => {
  await sequelize.query(`
    INSERT INTO financial_goals
      (household_id, user_id, name, target_amount, current_amount, currency,
       target_date, monthly_contribution, linked_account_id, priority, status,
       notes, created_at, updated_at)
    VALUES
      (1, 1, 'Old laptop fund', 2000, 2000, 'CAD',
       '2025-12-01', NULL, NULL, 0, 'completed',
       NULL, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT status FROM financial_goals WHERE name = 'Old laptop fund'`,
  );
  const row = (rows as Array<{ status: string }>)[0];
  assert.equal(row.status, 'completed');
});

test('down drops the financial_goals table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('financial_goals'),
    `financial_goals should be gone, found: ${tables.join(', ')}`,
  );
});
