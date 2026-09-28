/**
 * Round-trip + backfill test for migration 20260928000001-transaction-source-tier.
 *
 * On an in-memory SQLite DB, seeds a transactions table carrying the columns the
 * backfill reads, runs up(), and asserts: the column exists with the
 * conservative default; SimpleFIN-batch rows are marked provisional; every other
 * row — statement, CSV, PDF — stays authoritative; then runs down() and confirms
 * the column and its index are gone.
 *
 * The backfill keys on the batch shape simplefin/sync.ts builds,
 * `simplefin-<integrationId>-<accountId>-<ms>`. Getting that wrong in either
 * direction is costly: a statement row wrongly marked provisional becomes
 * eligible for deletion by a later import, and a feed row left authoritative
 * never gets corrected when it settles at a different amount.
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
  await qi.createTable('transactions', {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    account_id: { type: 'INTEGER', allowNull: false },
    date: { type: 'VARCHAR(10)', allowNull: false },
    import_batch: { type: 'VARCHAR(255)', allowNull: true },
  });

  await qi.bulkInsert('transactions', [
    // Feed rows: the batch shape simplefin/sync.ts emits.
    { id: 1, account_id: 4, date: '2026-09-26', import_batch: 'simplefin-1-4-1790000000000' },
    { id: 2, account_id: 8, date: '2026-09-26', import_batch: 'simplefin-1-8-1790000000000' },
    // Statement imports: the real batch names in production data.
    { id: 3, account_id: 40, date: '2026-08-23', import_batch: '2026-09 741005' },
    { id: 4, account_id: 1, date: '2026-08-23', import_batch: '2026-09 701001' },
    { id: 5, account_id: 14, date: '2026-05-01', import_batch: 'WS deposit ledger cleanup' },
    // A batch that merely CONTAINS the word, to prove the prefix is anchored.
    { id: 6, account_id: 5, date: '2026-07-01', import_batch: 'legacy-simplefin-export' },
  ]);

  // require, not import(): these migrations are CommonJS and a dynamic import
  // wraps them in .default under tsx. Matches the other migration tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260928000001-transaction-source-tier.js');
  await migration.up(qi, Sequelize);
});

after(async () => {
  await sequelize.close();
});

async function tierOf(id: number): Promise<string> {
  const [rows] = await sequelize.query(`SELECT source_tier FROM transactions WHERE id = ${id}`);
  return (rows[0] as { source_tier: string }).source_tier;
}

test('feed rows are backfilled as provisional', async () => {
  assert.equal(await tierOf(1), 'provisional');
  assert.equal(await tierOf(2), 'provisional');
});

test('statement-derived rows stay authoritative', async () => {
  assert.equal(await tierOf(3), 'authoritative');
  assert.equal(await tierOf(4), 'authoritative');
  assert.equal(await tierOf(5), 'authoritative');
});

test('the prefix is anchored, not a substring match', async () => {
  // 'legacy-simplefin-export' contains the word but is not a feed batch. A
  // LIKE '%simplefin%' would wrongly make this deletable by a later statement.
  assert.equal(await tierOf(6), 'authoritative');
});

test('a row inserted without a tier gets the conservative default', async () => {
  await sequelize.query(
    `INSERT INTO transactions (id, account_id, date, import_batch)
     VALUES (7, 4, '2026-09-27', 'some-new-importer')`,
  );
  assert.equal(await tierOf(7), 'authoritative');
});

test('down() removes the column and its index', async () => {
  const qi = sequelize.getQueryInterface();
  await migration.down(qi, Sequelize);
  const desc = await qi.describeTable('transactions');
  assert.equal('source_tier' in desc, false);
  const indexes = (await qi.showIndex('transactions')) as Array<{ name: string }>;
  assert.equal(
    indexes.some((i) => i.name === 'transactions_account_tier_date'),
    false,
  );
});
