import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  // Minimal pre-migration table (mirrors 20260612000002, sans the cross-table
  // FKs that don't exist in this in-memory fixture).
  await qi.createTable('subscription_price_changes', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    subscription_id: { type: DataTypes.BIGINT, allowNull: false },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    detected_on: { type: DataTypes.DATEONLY, allowNull: false },
    previous_amount_cents: { type: DataTypes.BIGINT, allowNull: false },
    new_amount_cents: { type: DataTypes.BIGINT, allowNull: false },
    pct_change: { type: DataTypes.DECIMAL(6, 3), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    triggering_transaction_id: { type: DataTypes.BIGINT, allowNull: true },
    acknowledged_at: { type: DataTypes.DATE, allowNull: true },
    acknowledged_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260613000001-relax-subscription-price-change-fk.js');
});

after(async () => { await sequelize.close(); });

test('up drops + recreates the table with a plain subscription_id column', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('subscription_price_changes');
  assert.ok(desc.subscription_id, 'subscription_id column exists');
  assert.equal(desc.subscription_id.allowNull, false);
  assert.ok(desc.new_amount_cents, 'new_amount_cents column exists');
  assert.ok(desc.acknowledged_at, 'acknowledged_at column exists');
});

test('down recreates the table (round-trip)', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('subscription_price_changes');
  assert.ok(desc.subscription_id, 'subscription_id column exists after down');
  assert.equal(desc.subscription_id.allowNull, false);
});
