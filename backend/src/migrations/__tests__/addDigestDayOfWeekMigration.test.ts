/**
 * Round-trip test for the digest day-of-week migration (issue #796, AC #8 / #12).
 *
 * `up` adds `notification_preferences.digest_day_of_week` defaulting to 1
 * (Monday). `down` removes it. Runs on in-memory SQLite so it's an
 * auto-discovered unit test; the dialect-portable DDL (a single addColumn)
 * means the same migration runs verbatim on Postgres in prod.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

let sequelize: Sequelize;
let migration: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up: (...args: any[]) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  down: (...args: any[]) => Promise<void>;
};

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();

  // Minimal prerequisite table: the migration only touches
  // notification_preferences, so we stand up just enough of it via raw SQL
  // (a pre-existing row included) to prove the new column's default backfills.
  await sequelize.query(
    `CREATE TABLE notification_preferences (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id INTEGER NOT NULL,
       type TEXT NOT NULL,
       channel_in_app BOOLEAN NOT NULL DEFAULT 1,
       channel_email BOOLEAN NOT NULL DEFAULT 0,
       channel_push BOOLEAN NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  await sequelize.query(
    `INSERT INTO notification_preferences
       (user_id, type, channel_in_app, channel_email, channel_push, created_at, updated_at)
     VALUES (1, 'digest.weekly', 1, 0, 0, datetime('now'), datetime('now'))`,
  );
  void qi;

  migration = require('../20260627000001-add-digest-day-of-week.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds digest_day_of_week (default Monday=1) and backfills existing rows', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const qi = sequelize.getQueryInterface();

  const desc = await qi.describeTable('notification_preferences');
  assert.ok(desc.digest_day_of_week, 'digest_day_of_week column added');

  const [rows] = await sequelize.query(
    'SELECT digest_day_of_week FROM notification_preferences WHERE user_id = 1',
  );
  const value = (rows as Array<{ digest_day_of_week: unknown }>)[0]
    .digest_day_of_week;
  assert.equal(Number(value), 1, 'existing row backfilled to Monday=1');
});

test('down removes digest_day_of_week', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable(
    'notification_preferences',
  );
  assert.equal(desc.digest_day_of_week, undefined, 'digest_day_of_week removed');
});

test('up again after down is a clean idempotent round-trip', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable(
    'notification_preferences',
  );
  assert.ok(desc.digest_day_of_week, 're-added digest_day_of_week');
});
