import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mig = { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };
let migration: Mig;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  // Precursor tables: users, households, budget_targets — the migration's
  // FK references resolve against these. Keep schemas minimal — only what
  // the migration touches.
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('budget_targets', {
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
    exclude_refunded_purchases: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  // Seed a legacy budget so we can prove the default backfills cleanly.
  await sequelize.query(
    `INSERT INTO budget_targets
      (id, household_id, category, currency, amount, period, scope, rollover_enabled, exclude_refunded_purchases, created_at, updated_at)
     VALUES (1, 1, 'Groceries', 'CAD', 400, 'monthly', 'household', 0, 0, datetime('now'), datetime('now'))`,
  );

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260603100020-budget-breach-alerts.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds alert_thresholds column to budget_targets with default backfill', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.ok(cols.alert_thresholds, 'alert_thresholds column should exist');
  // Legacy row gets the default — stored as JSON text in sqlite.
  const [rows] = await sequelize.query(
    `SELECT alert_thresholds FROM budget_targets WHERE id = 1`,
  );
  const row = (rows as Array<{ alert_thresholds: string | null }>)[0];
  assert.ok(row.alert_thresholds != null, 'alert_thresholds should backfill');
  const parsed =
    typeof row.alert_thresholds === 'string'
      ? JSON.parse(row.alert_thresholds)
      : row.alert_thresholds;
  assert.deepEqual(parsed, [80, 100, 120]);
});

test('up creates budget_alert_states table with expected columns', async () => {
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('budget_alert_states'),
    `Expected budget_alert_states in: ${tables.join(', ')}`,
  );
  const cols = await sequelize
    .getQueryInterface()
    .describeTable('budget_alert_states');
  assert.equal(cols.user_id?.allowNull, false);
  assert.equal(cols.budget_target_id?.allowNull, false);
  assert.equal(cols.period_key?.allowNull, false);
  assert.equal(cols.threshold?.allowNull, false);
  assert.equal(cols.alerted_at?.allowNull, false);
});

test('budget_alert_states unique (user_id, budget_target_id, period_key, threshold)', async () => {
  await sequelize.query(
    `INSERT INTO budget_alert_states
       (user_id, budget_target_id, period_key, threshold, alerted_at, created_at, updated_at)
     VALUES (1, 1, '2026-05', 80, datetime('now'), datetime('now'), datetime('now'))`,
  );
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO budget_alert_states
           (user_id, budget_target_id, period_key, threshold, alerted_at, created_at, updated_at)
         VALUES (1, 1, '2026-05', 80, datetime('now'), datetime('now'), datetime('now'))`,
      ),
    (err: Error) => err instanceof Error,
  );
  // A different threshold for the same period is allowed.
  await sequelize.query(
    `INSERT INTO budget_alert_states
       (user_id, budget_target_id, period_key, threshold, alerted_at, created_at, updated_at)
     VALUES (1, 1, '2026-05', 100, datetime('now'), datetime('now'), datetime('now'))`,
  );
});

test('budget_alert_states unique index visible by name', async () => {
  const indexes = await sequelize
    .getQueryInterface()
    .showIndex('budget_alert_states');
  const found = (
    indexes as Array<{ name: string; unique?: boolean }>
  ).find(
    (i) => i.name === 'budget_alert_states_user_budget_period_threshold',
  );
  assert.ok(found, 'expected unique index by name');
  assert.equal(found?.unique, true);
});

test('down drops budget_alert_states and removes alert_thresholds column', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('budget_alert_states'),
    `budget_alert_states should be gone, found: ${tables.join(', ')}`,
  );
  const cols = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.equal(cols.alert_thresholds, undefined);
});
