/**
 * Round-trip test for the push-subscriptions migration (issue #651, AC #10).
 *
 * `up` creates `push_subscriptions` (unique endpoint, user_id index, user FK)
 * and adds `notification_preferences.channel_push` defaulting to `false`.
 * `down` removes the column and drops the table. Runs on in-memory SQLite so
 * it's an auto-discovered unit test; the dialect-portable DDL (createTable /
 * addColumn / addIndex only) means the same migration runs verbatim on
 * Postgres in prod.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();

  // Prerequisite tables the migration references.
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await qi.createTable('notification_preferences', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    type: { type: DataTypes.STRING(64), allowNull: false },
    channel_in_app: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    channel_email: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  // A pre-existing preference row, to prove the backfill default lands.
  await sequelize.query('INSERT INTO users (id) VALUES (1)');
  const now = new Date().toISOString();
  await qi.bulkInsert('notification_preferences', [
    {
      user_id: 1,
      type: 'budget.breach',
      channel_in_app: true,
      channel_email: false,
      created_at: now,
      updated_at: now,
    },
  ]);

  migration = require('../20260619120000-push-subscriptions.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates push_subscriptions and adds channel_push (default false)', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const qi = sequelize.getQueryInterface();

  // Table shape.
  const desc = await qi.describeTable('push_subscriptions');
  assert.ok(desc.id, 'has id');
  assert.ok(desc.user_id, 'has user_id');
  assert.ok(desc.endpoint, 'has endpoint');
  assert.ok(desc.p256dh, 'has p256dh');
  assert.ok(desc.auth, 'has auth');
  assert.ok(desc.user_agent, 'has user_agent');
  assert.ok(desc.created_at, 'has created_at');
  assert.ok(desc.updated_at, 'has updated_at');

  // Unique endpoint index present.
  const indexes = (await qi.showIndex('push_subscriptions')) as Array<{
    name: string;
    unique: boolean;
  }>;
  const endpointIdx = indexes.find((i) => i.name === 'push_subscriptions_endpoint_unique');
  assert.ok(endpointIdx, 'endpoint unique index exists');
  assert.equal(endpointIdx?.unique, true, 'endpoint index is unique');
  assert.ok(
    indexes.find((i) => i.name === 'push_subscriptions_user'),
    'user_id index exists',
  );

  // channel_push column added.
  const prefDesc = await qi.describeTable('notification_preferences');
  assert.ok(prefDesc.channel_push, 'channel_push column added');

  // Existing row backfilled to false.
  const [rows] = await sequelize.query(
    'SELECT channel_push FROM notification_preferences WHERE user_id = 1',
  );
  const value = (rows as Array<{ channel_push: unknown }>)[0].channel_push;
  // SQLite stores booleans as 0/1.
  assert.ok(value === 0 || value === false, 'existing row backfilled channel_push=false');
});

test('endpoint unique index rejects a duplicate endpoint', async () => {
  const now = new Date().toISOString();
  await sequelize.getQueryInterface().bulkInsert('push_subscriptions', [
    {
      user_id: 1,
      endpoint: 'https://push.example/abc',
      p256dh: 'k1',
      auth: 'a1',
      user_agent: null,
      created_at: now,
      updated_at: now,
    },
  ]);
  await assert.rejects(
    sequelize.getQueryInterface().bulkInsert('push_subscriptions', [
      {
        user_id: 1,
        endpoint: 'https://push.example/abc',
        p256dh: 'k2',
        auth: 'a2',
        user_agent: null,
        created_at: now,
        updated_at: now,
      },
    ]),
    'duplicate endpoint must violate the unique index',
  );
});

test('down removes channel_push and drops push_subscriptions', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const qi = sequelize.getQueryInterface();

  const prefDesc = await qi.describeTable('notification_preferences');
  assert.equal(prefDesc.channel_push, undefined, 'channel_push removed');

  await assert.rejects(
    qi.describeTable('push_subscriptions'),
    'push_subscriptions dropped',
  );
});

test('up again after down is a clean idempotent round-trip', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('push_subscriptions');
  assert.ok(desc.endpoint, 're-created table has endpoint');
});
