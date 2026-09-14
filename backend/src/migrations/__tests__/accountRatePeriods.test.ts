/**
 * Round-trip test for migration 20260917000001-account-rate-periods.
 *
 * Mirrors the pattern in accountCardIdentifiersMigration.test.ts: create
 * minimal `households`, `accounts`, and `account_statements` FK targets on
 * an in-memory SQLite DB, run `up`, assert shape + indexes + the unique
 * constraint that makes re-importing a statement idempotent, then run
 * `down` and confirm the table is gone.
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
  await sequelize.getQueryInterface().createTable('account_statements', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    account_id: { type: 'INTEGER', allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260917000001-account-rate-periods.js');
});

after(async () => {
  await sequelize.close();
});

test('up creates account_rate_periods with all columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('account_rate_periods');
  for (const col of [
    'id',
    'household_id',
    'account_id',
    'from_date',
    'to_date',
    'prime_rate',
    'premium',
    'effective_rate',
    'applicable_interest',
    'source_statement_id',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(desc[col], `expected column ${col}`);
  }
  assert.equal(desc.household_id.allowNull, false);
  assert.equal(desc.account_id.allowNull, false);
  assert.equal(desc.from_date.allowNull, false);
  assert.equal(desc.to_date.allowNull, false);
  assert.equal(desc.prime_rate.allowNull, true);
  assert.equal(desc.premium.allowNull, true);
  assert.equal(desc.effective_rate.allowNull, false);
  assert.equal(desc.applicable_interest.allowNull, true);
  assert.equal(desc.source_statement_id.allowNull, true);
});

test('up adds the account+from_date unique index plus a household_id index', async () => {
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('account_rate_periods')) as Array<{ name: string; unique?: boolean }>;
  const names = indexes.map((i) => i.name);
  assert.ok(
    names.includes('account_rate_periods_account_from_date'),
    `expected account+from_date index, got: ${names.join(', ')}`,
  );
  const uniqueIdx = indexes.find((i) => i.name === 'account_rate_periods_account_from_date');
  assert.equal(uniqueIdx?.unique, true, 'account_id+from_date index must be unique');
  assert.ok(
    names.includes('account_rate_periods_household_id'),
    `expected household_id index, got: ${names.join(', ')}`,
  );
});

test('unique (account_id, from_date) blocks re-importing the same rate window', async () => {
  await sequelize.query(`INSERT INTO households (id, name) VALUES (1, 'HH')`);
  await sequelize.query(`INSERT INTO accounts (id, name) VALUES (1, 'RBC Royal Credit Line')`);
  await sequelize.query(
    `INSERT INTO account_rate_periods
       (household_id, account_id, from_date, to_date, prime_rate, premium, effective_rate,
        applicable_interest, source_statement_id, created_at, updated_at)
     VALUES (1, 1, '2026-01-15', '2026-02-14', 4.4500, -0.5000, 3.9500, 12.3400, NULL,
             datetime('now'), datetime('now'))`,
  );
  await assert.rejects(
    () =>
      sequelize.query(
        `INSERT INTO account_rate_periods
           (household_id, account_id, from_date, to_date, prime_rate, premium, effective_rate,
            applicable_interest, source_statement_id, created_at, updated_at)
         VALUES (1, 1, '2026-01-15', '2026-02-20', 4.4500, -0.5000, 3.9500, 15.0000, NULL,
                 datetime('now'), datetime('now'))`,
      ),
    'a second row for the same (account_id, from_date) pair must violate the unique index',
  );
});

test('down drops the table cleanly (reversible)', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  await assert.rejects(
    () => sequelize.getQueryInterface().describeTable('account_rate_periods'),
    'table should no longer exist after down()',
  );
});
