/**
 * Round-trip test for migration 20260623000001-add-reimbursements-from-split.
 * In-memory SQLite: stub parents, create the base reimbursements table, run the
 * add-column migration up/down.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let base: { up: (...a: any[]) => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  for (const t of ['households', 'users', 'contacts', 'transactions']) {
    await qi.createTable(t, { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true } });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  base = require('../20260607000000-create-reimbursements.js');
  await base.up(qi, Sequelize);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260623000001-add-reimbursements-from-split.js');
});

after(async () => { await sequelize.close(); });

test('up adds from_split with default false', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('reimbursements');
  assert.ok('from_split' in cols, 'expected from_split column');
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO transactions (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO reimbursements (household_id, transaction_id, amount, currency, status, created_at, updated_at)
     VALUES (1, 1, '5.0000', 'CAD', 'expected', datetime('now'), datetime('now'))`,
  );
  const [rows] = (await sequelize.query(
    `SELECT from_split FROM reimbursements WHERE household_id = 1`,
  )) as [{ from_split: number }[], unknown];
  assert.equal(Number(rows[0]?.from_split), 0, 'default should be false/0');
});

test('down removes from_split', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('reimbursements');
  assert.ok(!('from_split' in cols), 'from_split should be gone');
});
