import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: {
  up: (...args: any[]) => Promise<void>;
  down: (...args: any[]) => Promise<void>;
};

before(async () => {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  const qi = sequelize.getQueryInterface();
  // Parent tables referenced by FKs (we only need id columns).
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260603200001-create-monthly-close-periods.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates monthly_close_periods and monthly_close_tasks tables', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('monthly_close_periods'),
    `Expected monthly_close_periods in: ${tables.join(', ')}`,
  );
  assert.ok(
    tables.includes('monthly_close_tasks'),
    `Expected monthly_close_tasks in: ${tables.join(', ')}`,
  );
});

test('monthly_close_periods has expected columns', async () => {
  const description = await sequelize
    .getQueryInterface()
    .describeTable('monthly_close_periods');
  assert.equal(description.household_id?.allowNull, false);
  assert.equal(description.user_id?.allowNull, false);
  assert.equal(description.period_month?.allowNull, false);
  assert.equal(description.status?.allowNull, false);
  assert.equal(description.opened_at?.allowNull, false);
  assert.equal(description.closed_at?.allowNull, true);
  assert.equal(description.notes?.allowNull, true);
});

test('monthly_close_tasks has expected columns', async () => {
  const description = await sequelize
    .getQueryInterface()
    .describeTable('monthly_close_tasks');
  assert.equal(description.period_id?.allowNull, false);
  assert.equal(description.task_key?.allowNull, false);
  assert.equal(description.is_complete?.allowNull, false);
  assert.equal(description.completed_at?.allowNull, true);
  assert.equal(description.completed_by_user_id?.allowNull, true);
  assert.equal(description.notes?.allowNull, true);
  assert.equal(description.sort_order?.allowNull, false);
});

test('inserting a period + tasks round-trips and persists fields', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);

  await sequelize.query(`
    INSERT INTO monthly_close_periods
      (household_id, user_id, period_month, status, opened_at, closed_at, notes,
       created_at, updated_at)
    VALUES
      (1, 1, '2026-05', 'open', datetime('now'), NULL, NULL,
       datetime('now'), datetime('now'))
  `);
  const [periodRows] = await sequelize.query(
    `SELECT id, status, period_month FROM monthly_close_periods WHERE period_month = '2026-05'`,
  );
  const period = (
    periodRows as Array<{ id: number; status: string; period_month: string }>
  )[0];
  assert.equal(period.status, 'open');
  assert.equal(period.period_month, '2026-05');

  await sequelize.query(`
    INSERT INTO monthly_close_tasks
      (period_id, task_key, is_complete, completed_at, completed_by_user_id,
       notes, sort_order, created_at, updated_at)
    VALUES
      (${period.id}, 'imports', 0, NULL, NULL, NULL, 10,
       datetime('now'), datetime('now'))
  `);
  const [taskRows] = await sequelize.query(
    `SELECT task_key, is_complete, sort_order FROM monthly_close_tasks WHERE period_id = ${period.id}`,
  );
  const task = (
    taskRows as Array<{ task_key: string; is_complete: number; sort_order: number }>
  )[0];
  assert.equal(task.task_key, 'imports');
  // SQLite stores booleans as 0/1.
  assert.equal(task.is_complete, 0);
  assert.equal(task.sort_order, 10);
});

test('(household_id, period_month) unique constraint rejects duplicates', async () => {
  let threw = false;
  try {
    await sequelize.query(`
      INSERT INTO monthly_close_periods
        (household_id, user_id, period_month, status, opened_at, closed_at, notes,
         created_at, updated_at)
      VALUES
        (1, 1, '2026-05', 'open', datetime('now'), NULL, NULL,
         datetime('now'), datetime('now'))
    `);
  } catch (e) {
    threw = true;
    assert.match(String(e), /UNIQUE|unique|constraint/i);
  }
  assert.equal(threw, true, 'duplicate period_month for the same household must throw');
});

test('down drops both tables cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('monthly_close_periods'),
    `monthly_close_periods should be gone, found: ${tables.join(', ')}`,
  );
  assert.ok(
    !tables.includes('monthly_close_tasks'),
    `monthly_close_tasks should be gone, found: ${tables.join(', ')}`,
  );
});
