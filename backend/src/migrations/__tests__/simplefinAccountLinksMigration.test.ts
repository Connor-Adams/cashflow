/**
 * Round-trip + backfill test for migration 20260628000001-simplefin-account-links
 * (#813). On an in-memory SQLite DB, seeds the minimal legacy tables
 * (user_simplefin_integrations, household_members, accounts), runs up(), and
 * asserts: the table + indexes exist; the backfill links unambiguous-name
 * accounts (first-writer-wins on account_id); an ambiguous name is NOT linked;
 * then runs down() and confirms the table is gone.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('user_simplefin_integrations', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    user_id: { type: 'INTEGER', allowNull: false },
    status: { type: 'VARCHAR(16)', allowNull: false, defaultValue: 'connected' },
  });
  await qi.createTable('household_members', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    user_id: { type: 'INTEGER', allowNull: false },
    household_id: { type: 'INTEGER', allowNull: false },
  });
  await qi.createTable('accounts', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    name: { type: 'VARCHAR(255)', allowNull: false },
    household_id: { type: 'INTEGER', allowNull: true },
    merged_into_id: { type: 'INTEGER', allowNull: true },
  });

  // user 1 in household 10, integration 1; accounts: a unique 'Chequing' and a
  // duplicated 'Shared' name (ambiguous → must NOT backfill).
  await qi.bulkInsert('user_simplefin_integrations', [
    { id: 1, user_id: 1, status: 'connected' },
    { id: 2, user_id: 2, status: 'disconnected' }, // disconnected → skipped
  ]);
  await qi.bulkInsert('household_members', [
    { user_id: 1, household_id: 10 },
    { user_id: 2, household_id: 10 },
  ]);
  await qi.bulkInsert('accounts', [
    { id: 100, name: 'Chequing', household_id: 10, merged_into_id: null },
    { id: 101, name: 'Shared', household_id: 10, merged_into_id: null },
    { id: 102, name: 'Shared', household_id: 10, merged_into_id: null },
    { id: 103, name: 'Merged', household_id: 10, merged_into_id: 100 }, // excluded
  ]);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260628000001-simplefin-account-links.js');
});

after(async () => {
  await sequelize.close();
});

test('AC8: up creates the table + unique indexes', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('simplefin_account_links');
  assert.ok(desc.integration_id);
  assert.ok(desc.simplefin_account_id);
  assert.ok(desc.account_id);
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('simplefin_account_links')) as Array<{ name: string; unique: boolean }>;
  assert.ok(indexes.some((i) => i.name === 'simplefin_account_links_integration_account' && i.unique));
  assert.ok(indexes.some((i) => i.name === 'simplefin_account_links_account_id' && i.unique));
  assert.ok(indexes.some((i) => i.name === 'simplefin_account_links_integration_id'));
});

test('AC8: backfill links the unambiguous account, skips the ambiguous name', async () => {
  const [rows] = (await sequelize.query(
    'SELECT integration_id, account_id FROM simplefin_account_links ORDER BY account_id',
  )) as [Array<{ integration_id: number; account_id: number }>, unknown];
  // Only the unique-name 'Chequing' (account 100) under the connected
  // integration 1 is linked; the duplicated 'Shared' (101/102) is ambiguous and
  // the merged account (103) is excluded; the disconnected integration (2) is skipped.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].integration_id, 1);
  assert.equal(rows[0].account_id, 100);
});

test('AC8: down drops the table (reversible)', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  await assert.rejects(
    sequelize.getQueryInterface().describeTable('simplefin_account_links'),
  );
});
