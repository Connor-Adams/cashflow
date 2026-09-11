/**
 * Round-trip test for migration 20260911000001-create-account-card-identifiers
 * (docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md).
 *
 * Mirrors the pattern in userSimplefinIntegrationsMigration.test.ts and
 * accountStatementsMigration.test.ts: create minimal `households` and
 * `accounts` FK targets on an in-memory SQLite DB, run `up`, assert shape +
 * indexes + the unique constraint, then run `down` and confirm the table is
 * gone.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // FK targets -- enough for the references clauses to resolve.
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    name: { type: 'VARCHAR(255)', allowNull: false },
  });
  await sequelize.getQueryInterface().createTable('accounts', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    name: { type: 'VARCHAR(255)', allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260911000001-create-account-card-identifiers.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates account_card_identifiers with all columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('account_card_identifiers');
  for (const col of [
    'id',
    'household_id',
    'account_id',
    'last4',
    'source',
    'first_seen_at',
    'last_seen_at',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(desc[col], `expected column ${col}`);
  }
  assert.equal(desc.household_id.allowNull, false);
  assert.equal(desc.account_id.allowNull, false);
  assert.equal(desc.last4.allowNull, false);
  assert.equal(desc.source.allowNull, false);
  assert.equal(desc.first_seen_at.allowNull, false);
  assert.equal(desc.last_seen_at.allowNull, false);
});

test('up adds the account+last4 unique index plus household_id and last4 indexes', async () => {
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('account_card_identifiers')) as Array<{ name: string; unique?: boolean }>;
  const names = indexes.map((i) => i.name);
  assert.ok(
    names.includes('account_card_identifiers_account_last4'),
    `expected account_last4 index, got: ${names.join(', ')}`,
  );
  const uniqueIdx = indexes.find((i) => i.name === 'account_card_identifiers_account_last4');
  assert.equal(uniqueIdx?.unique, true, 'account+last4 index must be unique');
  assert.ok(
    names.includes('account_card_identifiers_household_id'),
    `expected household_id index, got: ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('account_card_identifiers_last4'),
    `expected last4 index, got: ${names.join(', ')}`,
  );
});

test('unique (account_id, last4) blocks a duplicate pair', async () => {
  await sequelize.query(`INSERT INTO households (id, name) VALUES (1, 'HH')`);
  await sequelize.query(`INSERT INTO accounts (id, name) VALUES (1, 'Costco MC')`);
  await sequelize.query(
    `INSERT INTO account_card_identifiers
       (household_id, account_id, last4, source, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (1, 1, '3114', 'receipt_tender', datetime('now'), datetime('now'), datetime('now'), datetime('now'))`,
  );
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO account_card_identifiers
           (household_id, account_id, last4, source, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES (1, 1, '3114', 'receipt_tender', datetime('now'), datetime('now'), datetime('now'), datetime('now'))`,
      ),
    'a second row for the same (account_id, last4) pair must violate the unique index',
  );
});

test('down drops the table cleanly (reversible)', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  await assert.rejects(
    () => sequelize.getQueryInterface().describeTable('account_card_identifiers'),
    'table should no longer exist after down()',
  );
});
