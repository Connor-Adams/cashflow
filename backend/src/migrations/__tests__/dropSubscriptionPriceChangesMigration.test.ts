import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Stub the post-relax shape: subscription_id is a plain BIGINT (no FK).
  await sequelize.getQueryInterface().createTable('subscription_price_changes', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    subscription_id: { type: DataTypes.BIGINT, allowNull: false },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260614000002-drop-subscription-price-changes.js');
});

after(async () => { await sequelize.close(); });

test('up drops subscription_price_changes, down recreates it', async () => {
  const qi = sequelize.getQueryInterface();
  await migration.up(qi, Sequelize);
  await assert.rejects(() => qi.describeTable('subscription_price_changes'));
  await migration.down(qi, Sequelize);
  const cols = await qi.describeTable('subscription_price_changes');
  assert.ok(cols.subscription_id);
  assert.ok(cols.household_id);
  assert.ok(cols.new_amount_cents);
});
