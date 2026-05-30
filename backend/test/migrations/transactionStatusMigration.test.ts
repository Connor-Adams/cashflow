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
    account_id: { type: DataTypes.INTEGER, allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
  });
  await sequelize.query(
    `INSERT INTO transactions (id, account_id, date, amount) VALUES (1, 10, '2026-05-01', -42.50)`,
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260604100001-transactions-status.js');
});

after(async () => {
  await sequelize.close();
});

test('up: adds non-null status column with posted default and backfills rows', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok('status' in desc, 'status column missing');
  assert.equal(desc.status.allowNull, false);

  const [rows] = (await sequelize.query(`SELECT id, status FROM transactions`)) as [
    Array<{ id: number; status: string }>,
    unknown,
  ];
  assert.deepEqual(rows, [{ id: 1, status: 'posted' }]);
});

test('up: creates status/account/date composite index', async () => {
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('transactions')) as Array<{ name: string }>;
  assert.ok(
    indexes.some((i) => i.name === 'transactions_status_account_id_date'),
    `expected transactions_status_account_id_date, got ${indexes.map((i) => i.name).join(', ')}`,
  );
});

test('down: removes index and status column cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok(!('status' in desc), 'status column should be removed');
  const indexes = (await sequelize
    .getQueryInterface()
    .showIndex('transactions')) as Array<{ name: string }>;
  assert.ok(!indexes.some((i) => i.name === 'transactions_status_account_id_date'));
});

