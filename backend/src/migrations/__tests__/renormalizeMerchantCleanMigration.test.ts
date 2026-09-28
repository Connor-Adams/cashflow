/**
 * Round-trip test for migration 20260928000002-renormalize-merchant-clean.
 *
 * The migration re-keys historical `transactions.merchant_clean` with the
 * boilerplate-stripping normalizer added in the same PR. Without it, existing
 * merchant-memory buckets keyed on boilerplate-laden strings (e.g.
 * `DISCORD* NITROMONTHLY SAN FRANCISCO [UNITED STATES DOLLAR 11.29 @ 1.4349]`)
 * become unreachable the moment a new import produces `DISCORD* NITROMONTHLY
 * SAN FRANCISCO`, and the new key starts at zero support — the change would
 * make categorisation worse before it got better.
 *
 * What is asserted here:
 *   - the three boilerplate families are stripped from stored rows;
 *   - support counts MERGE (rows that used to hold N distinct keys now share
 *     one, so a `GROUP BY merchant_clean` sees N support instead of N x 1);
 *   - a merge whose rows disagree on the final categorisation keeps BOTH
 *     labels on their own rows (nothing is silently overwritten);
 *   - rows already normalized are untouched, and `up` is idempotent;
 *   - the recomputable `merchant_embeddings` cache is pruned of keys that no
 *     longer exist;
 *   - `down` runs cleanly.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes, type QueryInterface } from 'sequelize';

type Migration = {
  up: (qi: QueryInterface, s: typeof Sequelize) => Promise<void>;
  down: (qi: QueryInterface, s: typeof Sequelize) => Promise<void>;
};

let sequelize: Sequelize;
let migration: Migration;

const ROWS: Array<{ id: number; mc: string; cat: string | null; reviewed: string | null }> = [
  // FX-rate suffix: three keys for one Discord subscription. Two are reviewed
  // and AGREE, so the merged bucket gets support 2 on one category.
  { id: 1, mc: 'DISCORD* NITROMONTHLY SAN FRANCISCO [UNITED STATES DOLLAR 11.29 @ 1.4349]', cat: 'Discord Nitro', reviewed: '2026-01-02' },
  { id: 2, mc: 'DISCORD* NITROMONTHLY SAN FRANCISCO [UNITED STATES DOLLAR 11.29 @ 1.4101]', cat: 'Discord Nitro', reviewed: '2026-02-02' },
  { id: 3, mc: 'DISCORD* NITROMONTHLY SAN FRANCISCO [UNITED STATES DOLLAR 11.29 @ 1.44641]', cat: null, reviewed: null },
  // Wealthsimple date sentences: two keys for one activity, reviewed rows
  // DISAGREE on category (the label noise the calibration study found).
  { id: 4, mc: 'Money transfer out of the account (executed at 2026-03-08)', cat: 'Transfer', reviewed: '2026-03-09' },
  { id: 5, mc: 'Money transfer out of the account (executed at 2026-07-01)', cat: 'Investments', reviewed: '2026-07-02' },
  // Interac prefix: two terminal references for one merchant.
  { id: 6, mc: 'CONTACTLESS INTERAC PURCHASE - 5587 TIM HORTONS', cat: null, reviewed: null },
  { id: 7, mc: 'CONTACTLESS INTERAC PURCHASE - 9315 TIM HORTONS', cat: null, reviewed: null },
  // ...and the plain credit-card spelling of the same merchant, already clean.
  { id: 8, mc: 'TIM HORTONS', cat: 'Eating Out', reviewed: '2026-04-01' },
  // Already normalized — must be left byte-identical.
  { id: 9, mc: 'FARM BOY GUELPH', cat: 'Groceries', reviewed: '2026-05-01' },
  // Nothing but boilerplate: must keep something to key on, not become ''.
  { id: 10, mc: 'CONTACTLESS INTERAC PURCHASE -', cat: null, reviewed: null },
  // NULL merchant_clean must survive untouched.
  { id: 11, mc: '', cat: null, reviewed: null },
];

async function readRows(): Promise<Array<[number, string | null]>> {
  const [rows] = await sequelize.query('SELECT id, merchant_clean FROM transactions ORDER BY id ASC');
  return (rows as Array<{ id: number; merchant_clean: string | null }>).map((r) => [r.id, r.merchant_clean]);
}

async function byId(): Promise<Map<number, string | null>> {
  return new Map(await readRows());
}

/** Mirrors `findMerchantMemory`'s aggregation: support per (key, category). */
async function memoryBuckets(key: string): Promise<Array<{ key: string; cat: string; support: number }>> {
  const [rows] = await sequelize.query(
    `SELECT merchant_clean AS key, final_category AS cat, COUNT(*) AS support
       FROM transactions
      WHERE reviewed_at IS NOT NULL AND final_category IS NOT NULL
        AND merchant_clean = :key
      GROUP BY merchant_clean, final_category
      ORDER BY final_category ASC`,
    { replacements: { key } },
  );
  return (rows as Array<{ key: string; cat: string; support: number | string }>).map((r) => ({
    key: r.key,
    cat: r.cat,
    support: Number(r.support),
  }));
}

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: true },
    merchant_raw: { type: DataTypes.TEXT, allowNull: true },
    merchant_clean: { type: DataTypes.TEXT, allowNull: true },
    final_category: { type: DataTypes.STRING(120), allowNull: true },
    reviewed_at: { type: DataTypes.DATE, allowNull: true },
  });
  await qi.createTable('merchant_embeddings', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    merchant_clean: { type: DataTypes.TEXT, allowNull: false },
    embedding: { type: DataTypes.TEXT, allowNull: false },
    dim: { type: DataTypes.INTEGER, allowNull: false },
    model: { type: DataTypes.STRING(120), allowNull: false },
  });

  for (const r of ROWS) {
    await sequelize.query(
      `INSERT INTO transactions (id, household_id, merchant_raw, merchant_clean, final_category, reviewed_at)
       VALUES (:id, 1, :raw, :mc, :cat, :reviewed)`,
      {
        replacements: {
          id: r.id,
          raw: r.mc === '' ? null : r.mc,
          mc: r.mc === '' ? null : r.mc,
          cat: r.cat,
          reviewed: r.reviewed,
        },
      },
    );
  }
  // One cache row whose key the migration invalidates, one it must keep.
  await sequelize.query(
    `INSERT INTO merchant_embeddings (household_id, merchant_clean, embedding, dim, model) VALUES
      (1, 'DISCORD* NITROMONTHLY SAN FRANCISCO [UNITED STATES DOLLAR 11.29 @ 1.4349]', '[0.1]', 1, 'm'),
      (1, 'FARM BOY GUELPH', '[0.2]', 1, 'm')`,
  );

  migration = require('../20260928000002-renormalize-merchant-clean.js') as Migration;
});

after(async () => {
  await sequelize.close();
});

test('up strips the FX-rate suffix and merges the support onto one key', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const rows = await byId();
  assert.equal(rows.get(1), 'DISCORD* NITROMONTHLY SAN FRANCISCO');
  assert.equal(rows.get(2), 'DISCORD* NITROMONTHLY SAN FRANCISCO');
  assert.equal(rows.get(3), 'DISCORD* NITROMONTHLY SAN FRANCISCO');

  assert.deepEqual(
    await memoryBuckets('DISCORD* NITROMONTHLY SAN FRANCISCO'),
    [{ key: 'DISCORD* NITROMONTHLY SAN FRANCISCO', cat: 'Discord Nitro', support: 2 }],
    'two 1-support buckets merge into one 2-support bucket',
  );
});

test('up strips date-bearing Wealthsimple sentences', async () => {
  const rows = await byId();
  assert.equal(rows.get(4), 'Money transfer out of the account');
  assert.equal(rows.get(5), 'Money transfer out of the account');
});

test('a merge whose rows disagree on category keeps both labels on their own rows', async () => {
  // The merge rule: support counts merge by re-keying, and NO row's label is
  // rewritten. A disagreement therefore survives as two buckets under one key,
  // and `findMerchantMemory` resolves it deterministically (highest support,
  // then most recent reviewed_at, then category name) rather than letting
  // insertion order pick a winner.
  assert.deepEqual(await memoryBuckets('Money transfer out of the account'), [
    { key: 'Money transfer out of the account', cat: 'Investments', support: 1 },
    { key: 'Money transfer out of the account', cat: 'Transfer', support: 1 },
  ]);
});

test('up strips the Interac prefix and merges onto the plain merchant key', async () => {
  const rows = await byId();
  assert.equal(rows.get(6), 'TIM HORTONS');
  assert.equal(rows.get(7), 'TIM HORTONS');
  assert.equal(rows.get(8), 'TIM HORTONS', 'already-clean row unchanged');
  assert.deepEqual(await memoryBuckets('TIM HORTONS'), [
    { key: 'TIM HORTONS', cat: 'Eating Out', support: 1 },
  ]);
});

test('up leaves clean rows, all-boilerplate rows and NULLs alone', async () => {
  const rows = await byId();
  assert.equal(rows.get(9), 'FARM BOY GUELPH');
  assert.equal(rows.get(10), 'CONTACTLESS INTERAC PURCHASE -', 'never collapses to empty');
  assert.equal(rows.get(11), null, 'NULL merchant_clean untouched');
});

test('up prunes merchant_embeddings rows whose key no longer exists', async () => {
  const [rows] = await sequelize.query(
    'SELECT merchant_clean FROM merchant_embeddings ORDER BY merchant_clean ASC',
  );
  assert.deepEqual(
    (rows as Array<{ merchant_clean: string }>).map((r) => r.merchant_clean),
    ['FARM BOY GUELPH'],
    'the stale FX-suffixed cache key is dropped; the still-valid one stays',
  );
});

test('up is idempotent', async () => {
  const first = await readRows();
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  assert.deepEqual(await readRows(), first);
});

test('down runs cleanly and leaves the re-keyed values in place', async () => {
  const before_ = await readRows();
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  assert.deepEqual(await readRows(), before_);
});
