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
import { Sequelize, DataTypes } from 'sequelize';

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

  await qi.createTable('notification_preferences', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    type: { type: DataTypes.STRING(64), allowNull: false },
    channel_in_app: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    channel_email: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    channel_push: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  // A pre-existing preference row, to prove the default lands.
  const now = new Date().toISOString();
  await qi.bulkInsert('notification_preferences', [
    {
      user_id: 1,
      type: 'digest.weekly',
      channel_in_app: true,
      channel_email: false,
      channel_push: false,
      created_at: now,
      updated_at: now,
    },
  ]);

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
