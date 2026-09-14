import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('reimbursements', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    transaction_id: { type: DataTypes.INTEGER, allowNull: false },
    contact_id: { type: DataTypes.INTEGER, allowNull: true },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await sequelize.query(`INSERT INTO reimbursements
    (id, household_id, transaction_id, contact_id, amount, currency, status, created_at, updated_at)
    VALUES (1, 1, 100, 4, 500.0000, 'CAD', 'expected', datetime('now'), datetime('now'))`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260916000001-reimbursement-interest-rows.js');
});
after(async () => { await sequelize.close(); });

test('up defaults existing rows to principal with no source', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [rows] = await sequelize.query('SELECT kind, source_transaction_id FROM reimbursements WHERE id = 1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (rows as any[])[0];
  assert.equal(r.kind, 'principal', 'pre-existing claims are principal, not interest');
  assert.equal(r.source_transaction_id, null);
});

test('the unique index rejects two interest rows for the same charge and contact', async () => {
  await sequelize.query(`INSERT INTO reimbursements
    (id, household_id, transaction_id, contact_id, amount, currency, status, kind, source_transaction_id, created_at, updated_at)
    VALUES (2, 1, 200, 4, 12.3400, 'CAD', 'expected', 'interest', 999, datetime('now'), datetime('now'))`);
  await sequelize.query(`INSERT INTO reimbursements
    (id, household_id, transaction_id, contact_id, amount, currency, status, kind, source_transaction_id, created_at, updated_at)
    VALUES (3, 1, 201, 4, 12.3400, 'CAD', 'expected', 'interest', 999, datetime('now'), datetime('now'))`).then(
    () => assert.fail('expected a unique-index violation — re-running the allocator must not double-charge'),
    () => { /* expected */ },
  );
});

test('down removes both columns and the index', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('reimbursements');
  assert.equal(desc.kind, undefined);
  assert.equal(desc.source_transaction_id, undefined);
});
