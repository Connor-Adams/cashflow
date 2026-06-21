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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260603000002-create-notifications.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates notifications and notification_preferences tables', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    tables.includes('notifications'),
    `Expected notifications in: ${tables.join(', ')}`,
  );
  assert.ok(
    tables.includes('notification_preferences'),
    `Expected notification_preferences in: ${tables.join(', ')}`,
  );
});

test('notifications has expected columns', async () => {
  const description = await sequelize.getQueryInterface().describeTable('notifications');
  assert.equal(description.user_id?.allowNull, false);
  assert.equal(description.type?.allowNull, false);
  assert.equal(description.severity?.allowNull, false);
  assert.equal(description.title?.allowNull, false);
  assert.equal(description.body?.allowNull, false);
  assert.equal(description.data_json?.allowNull, true);
  assert.equal(description.read_at?.allowNull, true);
  assert.equal(description.created_at?.allowNull, false);
  assert.equal(description.updated_at?.allowNull, false);
});

test('notification_preferences has expected columns', async () => {
  const description = await sequelize
    .getQueryInterface()
    .describeTable('notification_preferences');
  assert.equal(description.user_id?.allowNull, false);
  assert.equal(description.type?.allowNull, false);
  assert.equal(description.channel_in_app?.allowNull, false);
  assert.equal(description.channel_email?.allowNull, false);
});

test('notifications composite index exists for bell query', async () => {
  const indexes = await sequelize
    .getQueryInterface()
    .showIndex('notifications');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('notifications_user_read_created'),
    `Expected notifications_user_read_created index, got: ${names.join(', ')}`,
  );
});

test('notification_preferences has unique index on (user_id, type)', async () => {
  const indexes = await sequelize
    .getQueryInterface()
    .showIndex('notification_preferences');
  const found = (
    indexes as Array<{ name: string; unique?: boolean }>
  ).find((i) => i.name === 'notification_preferences_user_type');
  assert.ok(found, 'Expected notification_preferences_user_type index');
  assert.equal(found?.unique, true);
});

test('notifications supports inserting an unread row with default severity', async () => {
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(`
    INSERT INTO notifications
      (user_id, type, severity, title, body, data_json, read_at,
       created_at, updated_at)
    VALUES
      (1, 'budget.breach', 'warn', 'Budget over', 'You spent 1.2x budget',
       NULL, NULL, datetime('now'), datetime('now'))
  `);
  const [rows] = await sequelize.query(
    `SELECT type, severity, read_at FROM notifications WHERE user_id = 1`,
  );
  const row = (rows as Array<{ type: string; severity: string; read_at: string | null }>)[0];
  assert.equal(row.type, 'budget.breach');
  assert.equal(row.severity, 'warn');
  assert.equal(row.read_at, null);
});

test('notification_preferences unique index rejects duplicate (user_id, type)', async () => {
  await sequelize.query(`
    INSERT INTO notification_preferences
      (user_id, type, channel_in_app, channel_email, created_at, updated_at)
    VALUES (1, 'budget.breach', 1, 0, datetime('now'), datetime('now'))
  `);
  let threw = false;
  try {
    await sequelize.query(`
      INSERT INTO notification_preferences
        (user_id, type, channel_in_app, channel_email, created_at, updated_at)
      VALUES (1, 'budget.breach', 0, 1, datetime('now'), datetime('now'))
    `);
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'Duplicate (user_id, type) should be rejected');
});

test('down drops both tables cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(
    !tables.includes('notifications'),
    `notifications should be gone, found: ${tables.join(', ')}`,
  );
  assert.ok(
    !tables.includes('notification_preferences'),
    `notification_preferences should be gone, found: ${tables.join(', ')}`,
  );
});
