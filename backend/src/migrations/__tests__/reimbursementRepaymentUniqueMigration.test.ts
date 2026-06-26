/**
 * Round-trip test for migration 20260626000001-reimbursement-repayment-unique
 * (issue #846). In-memory SQLite: stub parents, create the base reimbursements
 * table, run the partial-unique migration up, prove the constraint, run down,
 * prove the constraint is gone.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let base: { up: (...a: any[]) => Promise<void> };
let migration: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up: (...a: any[]) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  down: (...a: any[]) => Promise<void>;
};

async function insertClaim(repaymentId: number | null): Promise<void> {
  const col = repaymentId == null ? 'NULL' : String(repaymentId);
  await sequelize.query(
    `INSERT INTO reimbursements
       (household_id, transaction_id, amount, currency, status,
        repayment_transaction_id, created_at, updated_at)
     VALUES (1, 1, '5.0000', 'CAD', 'received', ${col},
             datetime('now'), datetime('now'))`,
  );
}

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  for (const t of ['households', 'users', 'contacts', 'transactions']) {
    await qi.createTable(t, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  base = require('../20260607000000-create-reimbursements.js');
  await base.up(qi, Sequelize);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260626000001-reimbursement-repayment-unique.js');
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO transactions (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO transactions (id) VALUES (2)`);
  await sequelize.query(`INSERT INTO transactions (id) VALUES (3)`);
});

after(async () => {
  await sequelize.close();
});

test('up: a non-null repayment_transaction_id can only be claimed once', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  // First link of repayment txn 2 succeeds.
  await insertClaim(2);
  // Second link of the SAME repayment txn 2 must violate the partial-unique.
  await assert.rejects(
    () => insertClaim(2),
    /unique|UNIQUE|constraint/i,
    'duplicate non-null repayment_transaction_id should be rejected',
  );
});

test('up: any number of NULL (unlinked) claims may coexist', async () => {
  await insertClaim(null);
  await insertClaim(null);
  const [rows] = (await sequelize.query(
    `SELECT COUNT(*) AS c FROM reimbursements WHERE repayment_transaction_id IS NULL`,
  )) as [{ c: number }[], unknown];
  assert.ok(Number(rows[0]?.c) >= 2, 'multiple unlinked claims allowed');
});

test('down: the unique constraint is dropped (duplicates allowed again)', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  // After down, linking repayment txn 3 twice must succeed.
  await insertClaim(3);
  await insertClaim(3);
  const [rows] = (await sequelize.query(
    `SELECT COUNT(*) AS c FROM reimbursements WHERE repayment_transaction_id = 3`,
  )) as [{ c: number }[], unknown];
  assert.equal(Number(rows[0]?.c), 2, 'down should allow duplicate repayment links');
});
