/**
 * Round-trip test for the `users.last_digest_sent_at` migration (issue #267).
 * Boots an in-memory sqlite with a minimal users table, then exercises:
 *   up()    — column + index appear
 *   down()  — column + index removed
 *   up()    — round-trip works again (idempotent shape)
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
  // Minimal users shape — only `id` is needed for the column add.
  await qi.createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING(320), allowNull: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260603000003-users-last-digest-sent-at.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds users.last_digest_sent_at column', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('users');
  assert.ok(desc.last_digest_sent_at, 'column should exist');
  assert.equal(desc.last_digest_sent_at?.allowNull, true);
});

test('up adds users_last_digest_sent_at index', async () => {
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('users')) as Array<{ name: string }>;
  const names = indexes.map((i) => i.name);
  assert.ok(
    names.includes('users_last_digest_sent_at'),
    `expected users_last_digest_sent_at, got: ${names.join(', ')}`,
  );
});

test('insert + select round-trips a NULL and a timestamp', async () => {
  await sequelize.query(`INSERT INTO users (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO users (id, last_digest_sent_at) VALUES (2, datetime('now'))`,
  );
  const [rows] = await sequelize.query(
    `SELECT id, last_digest_sent_at FROM users ORDER BY id`,
  );
  const list = rows as Array<{ id: number; last_digest_sent_at: string | null }>;
  assert.equal(list.length, 2);
  assert.equal(list[0].last_digest_sent_at, null);
  assert.ok(list[1].last_digest_sent_at, 'second row should have a timestamp');
});

test('down removes the column + index', async () => {
  await migration.down(sequelize.getQueryInterface());
  const desc = await sequelize.getQueryInterface().describeTable('users');
  assert.ok(
    desc.last_digest_sent_at == null,
    'column should be dropped',
  );
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('users')) as Array<{ name: string }>;
  const names = indexes.map((i) => i.name);
  assert.ok(
    !names.includes('users_last_digest_sent_at'),
    `index should be dropped, got: ${names.join(', ')}`,
  );
});

test('up again is idempotent (re-running survives)', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('users');
  assert.ok(desc.last_digest_sent_at);
});
