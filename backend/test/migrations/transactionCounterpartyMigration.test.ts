/**
 * Round-trip test for migration 20260605100000-transaction-counterparty.
 *
 * Mirrors the transferPurposeMigration test: in-memory SQLite, stub the
 * parent `transactions` table with the columns the migration touches, run
 * `up` + assert + `down` + assert.
 *
 * Coverage:
 *   - `up` adds `counterparty_raw` (nullable TEXT) and
 *     `counterparty_contact_id` (nullable INTEGER).
 *   - Pre-existing rows survive the round-trip.
 *   - Both columns accept NULL and string/int values respectively.
 *   - `down` removes both columns cleanly.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    merchant_raw: { type: DataTypes.STRING(1024), allowNull: false },
  });
  await sequelize.query(
    `INSERT INTO transactions (id, merchant_raw) VALUES (1, 'INTERAC E-TFR FROM JANE DOE')`,
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260605100000-transaction-counterparty.js');
});

after(async () => {
  await sequelize.close();
});

test('up: adds counterparty_raw and counterparty_contact_id columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok('counterparty_raw' in desc, 'counterparty_raw column missing');
  assert.ok('counterparty_contact_id' in desc, 'counterparty_contact_id column missing');
  assert.equal(desc.counterparty_raw.allowNull, true, 'counterparty_raw must be nullable');
  assert.equal(
    desc.counterparty_contact_id.allowNull,
    true,
    'counterparty_contact_id must be nullable',
  );
});

test('up preserves existing rows', async () => {
  const [rows] = (await sequelize.query(`SELECT id, merchant_raw FROM transactions`)) as [
    Array<{ id: number; merchant_raw: string }>,
    unknown,
  ];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].merchant_raw, 'INTERAC E-TFR FROM JANE DOE');
});

test('counterparty_raw accepts string + null', async () => {
  await sequelize.query(`UPDATE transactions SET counterparty_raw = 'JANE DOE' WHERE id = 1`);
  const [setRows] = (await sequelize.query(
    `SELECT counterparty_raw FROM transactions WHERE id = 1`,
  )) as [Array<{ counterparty_raw: string | null }>, unknown];
  assert.equal(setRows[0].counterparty_raw, 'JANE DOE');

  await sequelize.query(`UPDATE transactions SET counterparty_raw = NULL WHERE id = 1`);
  const [nulledRows] = (await sequelize.query(
    `SELECT counterparty_raw FROM transactions WHERE id = 1`,
  )) as [Array<{ counterparty_raw: string | null }>, unknown];
  assert.equal(nulledRows[0].counterparty_raw, null);
});

test('counterparty_contact_id accepts integer + null', async () => {
  await sequelize.query(`UPDATE transactions SET counterparty_contact_id = 42 WHERE id = 1`);
  const [setRows] = (await sequelize.query(
    `SELECT counterparty_contact_id FROM transactions WHERE id = 1`,
  )) as [Array<{ counterparty_contact_id: number | null }>, unknown];
  assert.equal(setRows[0].counterparty_contact_id, 42);

  await sequelize.query(`UPDATE transactions SET counterparty_contact_id = NULL WHERE id = 1`);
  const [nulledRows] = (await sequelize.query(
    `SELECT counterparty_contact_id FROM transactions WHERE id = 1`,
  )) as [Array<{ counterparty_contact_id: number | null }>, unknown];
  assert.equal(nulledRows[0].counterparty_contact_id, null);
});

test('down: removes both columns cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok(!('counterparty_raw' in desc), 'counterparty_raw should be removed');
  assert.ok(
    !('counterparty_contact_id' in desc),
    'counterparty_contact_id should be removed',
  );
});

test('down: data in untouched columns survives', async () => {
  const [rows] = (await sequelize.query(`SELECT id, merchant_raw FROM transactions`)) as [
    Array<{ id: number; merchant_raw: string }>,
    unknown,
  ];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].merchant_raw, 'INTERAC E-TFR FROM JANE DOE');
});
