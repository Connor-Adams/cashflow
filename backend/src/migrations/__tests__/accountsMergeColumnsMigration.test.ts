/**
 * Round-trip test for migration 20260626000001-accounts-merge-columns (#287).
 * Creates a minimal `accounts` table on an in-memory SQLite DB, runs up() to
 * add merged_into_id + merged_at + the index, asserts shape, then runs down()
 * and confirms the columns are gone again.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // A minimal accounts table — enough for addColumn / addIndex to target.
  await sequelize.getQueryInterface().createTable('accounts', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    name: { type: 'VARCHAR(255)', allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260626000001-accounts-merge-columns.js');
});

after(async () => {
  await sequelize.close();
});

test('up adds merged_into_id + merged_at columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('accounts');
  assert.ok(desc.merged_into_id, 'expected merged_into_id column');
  assert.ok(desc.merged_at, 'expected merged_at column');
  assert.equal(desc.merged_into_id.allowNull, true);
  assert.equal(desc.merged_at.allowNull, true);
});

test('up creates the accounts_merged_into_id index', async () => {
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('accounts')) as Array<{ name: string }>;
  assert.ok(
    indexes.some((i) => i.name === 'accounts_merged_into_id'),
    'expected accounts_merged_into_id index',
  );
});

test('down removes both columns + the index (reversible)', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('accounts');
  assert.equal(desc.merged_into_id, undefined, 'merged_into_id should be dropped');
  assert.equal(desc.merged_at, undefined, 'merged_at should be dropped');
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('accounts')) as Array<{ name: string }>;
  assert.ok(
    !indexes.some((i) => i.name === 'accounts_merged_into_id'),
    'accounts_merged_into_id index should be dropped',
  );
});
