import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('planned_events', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    price_change_detected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260614000001-drop-planned-events-price-change-detected.js');
});

after(async () => { await sequelize.close(); });

test('up removes price_change_detected, down re-adds it', async () => {
  const qi = sequelize.getQueryInterface();
  await migration.up(qi, Sequelize);
  let cols = await qi.describeTable('planned_events');
  assert.equal(cols.price_change_detected, undefined);
  await migration.down(qi, Sequelize);
  cols = await qi.describeTable('planned_events');
  assert.ok(cols.price_change_detected);
});
