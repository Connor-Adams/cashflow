import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('planned_events', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    expected_date: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'planned' },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260611000001-expectation-absorb-columns.js');
});

after(async () => { await sequelize.close(); });

test('M1 up adds kind + subscription columns with correct nullability', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('planned_events');
  assert.ok(desc.kind, 'kind exists');
  assert.equal(desc.kind.allowNull, false);
  assert.ok(desc.cadence);
  assert.equal(desc.cadence.allowNull, true);
  assert.ok(desc.normalized_name);
  assert.ok(desc.last_charge_date);
  assert.ok(desc.next_expected_date);
  assert.ok(desc.annualized_cost);
  assert.ok(desc.price_change_detected);
  assert.equal(desc.price_change_detected.allowNull, false);
  assert.ok(desc.cancellation_url);
  assert.ok(desc.category);
  assert.ok(desc.status_uncertain);
  assert.equal(desc.status_uncertain.allowNull, false);
});

test('M1 down removes the added columns', async () => {
  await migration.down(sequelize.getQueryInterface());
  const desc = await sequelize.getQueryInterface().describeTable('planned_events');
  assert.equal(desc.kind, undefined);
  assert.equal(desc.cadence, undefined);
  assert.equal(desc.status_uncertain, undefined);
});
