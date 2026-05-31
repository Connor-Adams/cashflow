import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: any;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('subscriptions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260611000003-drop-subscriptions.js');
});
after(async () => { await sequelize.close(); });

test('up drops subscriptions; down recreates it', async () => {
  const qi = sequelize.getQueryInterface();
  await migration.up(qi, Sequelize);
  await assert.rejects(qi.describeTable('subscriptions'));
  await migration.down(qi, Sequelize);
  const desc = await qi.describeTable('subscriptions');
  assert.ok(desc.household_id);
});
