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
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260601000001-create-planned-events.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates planned_events table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('planned_events'),
    `Expected planned_events in: ${tables.join(', ')}`,
  );
});

test('planned_events has expected columns including nullable ones', async () => {
  const description = await sequelize.getQueryInterface().describeTable('planned_events');
  // Required NOT NULL columns
  assert.equal(description.user_id?.allowNull, false);
  assert.equal(description.household_id?.allowNull, false);
  assert.equal(description.type?.allowNull, false);
  assert.equal(description.name?.allowNull, false);
  assert.equal(description.amount?.allowNull, false);
  assert.equal(description.currency?.allowNull, false);
  assert.equal(description.expected_date?.allowNull, false);
  assert.equal(description.source?.allowNull, false);
  assert.equal(description.status?.allowNull, false);
  // Nullable columns
  assert.equal(description.account_id?.allowNull, true);
  assert.equal(description.recurrence_rule?.allowNull, true);
  assert.equal(description.linked_transaction_id?.allowNull, true);
  assert.equal(description.notes?.allowNull, true);
});

test('planned_events supports a one-off row (recurrence_rule NULL)', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO accounts (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO planned_events
      (household_id, user_id, account_id, type, name, amount, currency,
       expected_date, recurrence_rule, source, status, linked_transaction_id,
       notes, created_at, updated_at)
    VALUES
      (1, 1, 1, 'expense', 'Rent', 1500, 'CAD',
       '2026-06-01', NULL, 'manual', 'planned', NULL,
       NULL, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT recurrence_rule, type, status FROM planned_events WHERE name = 'Rent'`,
  );
  const row = (rows as Array<{ recurrence_rule: string | null; type: string; status: string }>)[0];
  assert.equal(row.recurrence_rule, null);
  assert.equal(row.type, 'expense');
  assert.equal(row.status, 'planned');
});

test('planned_events supports a recurring row (recurrence_rule populated)', async () => {
  await sequelize.query(`
    INSERT INTO planned_events
      (household_id, user_id, account_id, type, name, amount, currency,
       expected_date, recurrence_rule, source, status, linked_transaction_id,
       notes, created_at, updated_at)
    VALUES
      (1, 1, 1, 'expense', 'Internet', 75, 'CAD',
       '2026-06-15', 'FREQ=MONTHLY;BYMONTHDAY=15', 'recurring_detection', 'planned',
       NULL, NULL, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT recurrence_rule, source FROM planned_events WHERE name = 'Internet'`,
  );
  const row = (rows as Array<{ recurrence_rule: string; source: string }>)[0];
  assert.equal(row.recurrence_rule, 'FREQ=MONTHLY;BYMONTHDAY=15');
  assert.equal(row.source, 'recurring_detection');
});

test('planned_events allows linking to a posted transaction', async () => {
  await sequelize.query(`INSERT INTO transactions (id) VALUES (100)`);
  await sequelize.query(`
    INSERT INTO planned_events
      (household_id, user_id, account_id, type, name, amount, currency,
       expected_date, recurrence_rule, source, status, linked_transaction_id,
       notes, created_at, updated_at)
    VALUES
      (1, 1, 1, 'expense', 'Confirmed', 100, 'CAD',
       '2026-05-26', NULL, 'manual', 'posted', 100,
       NULL, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT linked_transaction_id, status FROM planned_events WHERE name = 'Confirmed'`,
  );
  const row = (rows as Array<{ linked_transaction_id: number; status: string }>)[0];
  assert.equal(row.linked_transaction_id, 100);
  assert.equal(row.status, 'posted');
});

test('down drops the planned_events table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('planned_events'),
    `planned_events should be gone, found: ${tables.join(', ')}`,
  );
});
