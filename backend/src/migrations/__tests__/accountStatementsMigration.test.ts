/**
 * Round-trip test for migration 20260605000060-create-account-statements
 * (#242). Creates the table on an in-memory SQLite DB, asserts shape +
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
  migration = require('../20260605000060-create-account-statements.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates the account_statements table with the expected columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('account_statements');
  for (const col of [
    'id',
    'household_id',
    'account_id',
    'created_by_user_id',
    'visibility',
    'period_start',
    'period_end',
    'opening_balance',
    'closing_balance',
    'currency',
    'source_filename',
    'notes',
    'reconciled_at',
    'variance_explanation',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(desc[col], `expected column ${col}`);
  }
  assert.equal(desc.household_id.allowNull, false);
  assert.equal(desc.account_id.allowNull, false);
  assert.equal(desc.created_by_user_id.allowNull, true);
  assert.equal(desc.period_start.allowNull, false);
  assert.equal(desc.period_end.allowNull, false);
  assert.equal(desc.opening_balance.allowNull, false);
  assert.equal(desc.closing_balance.allowNull, false);
  assert.equal(desc.currency.allowNull, false);
  assert.equal(desc.reconciled_at.allowNull, true);
  assert.equal(desc.variance_explanation.allowNull, true);
});

test('up adds household, account, and unique-period indexes', async () => {
  const indexes = await sequelize
    .getQueryInterface()
    .showIndex('account_statements');
  const names = (indexes as Array<{ name: string; unique?: boolean }>).map(
    (i) => i.name,
  );
  assert.ok(
    names.includes('account_statements_household_id'),
    `expected household_id index, got: ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('account_statements_account_id'),
    `expected account_id index, got: ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('account_statements_account_period_unique'),
    `expected account+period unique index, got: ${names.join(', ')}`,
  );
});

test('unique (account_id, period_start, period_end) blocks duplicate periods', async () => {
  await sequelize.query(
    `INSERT INTO account_statements
       (household_id, account_id, created_by_user_id, visibility, period_start, period_end,
        opening_balance, closing_balance, currency, source_filename, notes,
        reconciled_at, variance_explanation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    {
      replacements: [
        1,
        100,
        null,
        'shared',
        '2026-01-01',
        '2026-01-31',
        '1000.0000',
        '950.0000',
        'CAD',
        null,
        null,
        null,
        null,
      ],
    },
  );
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO account_statements
           (household_id, account_id, created_by_user_id, visibility, period_start, period_end,
            opening_balance, closing_balance, currency, source_filename, notes,
            reconciled_at, variance_explanation, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        {
          replacements: [
            1,
            100,
            null,
            'shared',
            '2026-01-01',
            '2026-01-31',
            '500.0000',
            '450.0000',
            'CAD',
            null,
            null,
            null,
            null,
          ],
        },
      ),
    /UNIQUE|unique/i,
    'duplicate (account_id, period_start, period_end) must be rejected',
  );
});

test('down drops the table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  await assert.rejects(
    () => sequelize.getQueryInterface().describeTable('account_statements'),
    /no description|no such table|relation .* does not exist/i,
  );
});
