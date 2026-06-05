/**
 * Round-trip test for migration 20260604000001-create-transaction-revisions
 * (#229). Creates the table on an in-memory SQLite DB, asserts shape +
 * indexes, then runs down() and confirms the table is dropped cleanly.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260604000001-create-transaction-revisions.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates the transaction_revisions table with the expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('transaction_revisions');
  for (const col of [
    'id',
    'transaction_id',
    'household_id',
    'changed_by_user_id',
    'source',
    'ai_suggestion_id',
    'changes',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(desc[col], `expected column ${col}`);
  }
  assert.equal(desc.transaction_id.allowNull, false);
  assert.equal(desc.household_id.allowNull, true);
  assert.equal(desc.changed_by_user_id.allowNull, true);
  assert.equal(desc.ai_suggestion_id.allowNull, true);
  assert.equal(desc.source.allowNull, false);
});

test('up adds the timeline + audit indexes', async () => {
  const indexes = await sequelize
    .getQueryInterface()
    .showIndex('transaction_revisions');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('transaction_revisions_transaction_id'),
    `expected transaction_id index, got: ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('transaction_revisions_household_id'),
    `expected household_id index, got: ${names.join(', ')}`,
  );
});

test('changes column accepts a JSON-encoded diff payload', async () => {
  await sequelize.query(
    `INSERT INTO transaction_revisions
       (transaction_id, household_id, changed_by_user_id, source, ai_suggestion_id, changes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    {
      replacements: [
        1,
        2,
        3,
        'user_edit',
        null,
        JSON.stringify([
          { field: 'categoryOverride', before: null, after: 'Groceries' },
          { field: 'notes', before: null, after: 'On sale' },
        ]),
      ],
    },
  );
  const rows = await sequelize.query<{ changes: string; source: string }>(
    `SELECT source, changes FROM transaction_revisions ORDER BY id DESC LIMIT 1`,
    { type: 'SELECT' as never },
  );
  assert.equal(rows[0].source, 'user_edit');
  const parsed = JSON.parse(rows[0].changes) as Array<{ field: string; after: unknown }>;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].field, 'categoryOverride');
  assert.equal(parsed[0].after, 'Groceries');
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  await assert.rejects(
    () => sequelize.getQueryInterface().describeTable('transaction_revisions'),
    /no description|no such table|relation .* does not exist/i,
  );
});
