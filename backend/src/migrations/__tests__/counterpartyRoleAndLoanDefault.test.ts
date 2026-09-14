import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('contacts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await sequelize.query(`INSERT INTO transactions (id, household_id, amount, currency, created_at, updated_at)
    VALUES (1, 1, -40.0000, 'CAD', datetime('now'), datetime('now'))`);
  await sequelize.query(`INSERT INTO contacts (id, household_id, name, created_at, updated_at)
    VALUES (1, 1, 'Caelan Iten-McGrath', datetime('now'), datetime('now'))`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260915000001-counterparty-role-and-loan-default.js');
});
after(async () => { await sequelize.close(); });

test('up adds counterparty_role null and loan_default false', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [txns] = await sequelize.query('SELECT counterparty_role FROM transactions WHERE id = 1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((txns as any[])[0].counterparty_role, null, 'existing rows start untagged');
  const [contacts] = await sequelize.query('SELECT loan_default FROM contacts WHERE id = 1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = (contacts as any[])[0].loan_default;
  assert.ok(v === 0 || v === false, 'existing contacts default to not-a-lending-relationship');
});

test('down removes both columns', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const txnDesc = await sequelize.getQueryInterface().describeTable('transactions');
  assert.equal(txnDesc.counterparty_role, undefined);
  const contactDesc = await sequelize.getQueryInterface().describeTable('contacts');
  assert.equal(contactDesc.loan_default, undefined);
});
