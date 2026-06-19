/**
 * Round-trip test for migration 20260619000001-user-simplefin-integrations
 * (#790). Creates a minimal `users` table on an in-memory SQLite DB, runs up()
 * to create user_simplefin_integrations with all eight columns + the unique
 * user_id index, asserts shape, then runs down() and confirms the table is gone.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // The FK target — enough for the references clause to resolve.
  await sequelize.getQueryInterface().createTable('users', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    email: { type: 'VARCHAR(255)', allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260619000001-user-simplefin-integrations.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates user_simplefin_integrations with all eight columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable(
    'user_simplefin_integrations',
  );
  for (const col of [
    'id',
    'user_id',
    'access_url_encrypted',
    'status',
    'status_reason',
    'last_synced_at',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(desc[col], `expected column ${col}`);
  }
  assert.equal(desc.user_id.allowNull, false);
  assert.equal(desc.access_url_encrypted.allowNull, false);
  assert.equal(desc.status.allowNull, false);
  assert.equal(desc.status_reason.allowNull, true);
  assert.equal(desc.last_synced_at.allowNull, true);
});

test('up creates a UNIQUE index on user_id', async () => {
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('user_simplefin_integrations')) as Array<{ name: string; unique: boolean }>;
  const idx = indexes.find((i) => i.name === 'user_simplefin_integrations_user_id');
  assert.ok(idx, 'expected user_simplefin_integrations_user_id index');
  assert.equal(idx.unique, true, 'index must be unique');
});

test('down drops the table cleanly (reversible)', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  await assert.rejects(
    () =>
      sequelize
        .getQueryInterface()
        .describeTable('user_simplefin_integrations'),
    'table should no longer exist after down()',
  );
});
