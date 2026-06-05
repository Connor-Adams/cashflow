import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let m1: any; let m2: any;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('planned_events', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    type: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    expected_date: { type: DataTypes.DATEONLY, allowNull: false },
    source: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'manual' },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'planned' },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('household_members', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    role: { type: DataTypes.STRING(16), allowNull: false },
  });
  await qi.createTable('subscriptions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    merchant_name: { type: DataTypes.STRING(255), allowNull: false },
    normalized_name: { type: DataTypes.STRING(255), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    cadence: { type: DataTypes.STRING(16), allowNull: false },
    last_charge_date: { type: DataTypes.DATEONLY, allowNull: false },
    next_expected_date: { type: DataTypes.DATEONLY, allowNull: true },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'active' },
    category: { type: DataTypes.STRING(128), allowNull: true },
    annualized_cost: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    price_change_detected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    cancellation_url: { type: DataTypes.TEXT, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  m1 = require('../20260611000001-expectation-absorb-columns.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  m2 = require('../20260611000002-expectation-absorb-data.js');
  await m1.up(qi, Sequelize);
  const now = new Date();
  await qi.bulkInsert('household_members', [{ household_id: 1, user_id: 7, role: 'owner' }]);
  await qi.bulkInsert('subscriptions', [
    { household_id: 1, merchant_name: 'Netflix', normalized_name: 'netflix', amount: '20.0000', currency: 'CAD', cadence: 'monthly', last_charge_date: '2026-05-15', next_expected_date: '2026-06-15', status: 'active', category: 'Streaming', annualized_cost: '240.0000', price_change_detected: false, cancellation_url: null, notes: null, created_at: now, updated_at: now },
    { household_id: 1, merchant_name: 'Gym', normalized_name: 'gym', amount: '50.0000', currency: 'CAD', cadence: 'monthly', last_charge_date: '2026-05-01', next_expected_date: null, status: 'unknown', category: null, annualized_cost: '600.0000', price_change_detected: false, cancellation_url: null, notes: null, created_at: now, updated_at: now },
  ]);
});

after(async () => { await sequelize.close(); });

test('M2 copies subscriptions into planned_events as kind=subscription', async () => {
  await m2.up(sequelize.getQueryInterface(), Sequelize);
  const [rows] = await sequelize.query(
    "SELECT * FROM planned_events WHERE kind='subscription' ORDER BY name",
  );
  assert.equal(rows.length, 2);
  const gym = rows.find((r: { name: string }) => r.name === 'Gym');
  const netflix = rows.find((r: { name: string }) => r.name === 'Netflix');
  assert.equal(netflix.user_id, 7);
  assert.equal(gym.expected_date, '2026-05-01');
  assert.equal(netflix.expected_date, '2026-06-15');
  assert.equal(netflix.status, 'planned');
  assert.equal(gym.status, 'planned');
  assert.equal(!!gym.status_uncertain, true);
  assert.equal(!!netflix.status_uncertain, false);
  assert.equal(netflix.cadence, 'monthly');
  assert.equal(netflix.type, 'expense');
  assert.equal(netflix.source, 'recurring_detection');
});

test('M2 down removes only the copied subscription rows', async () => {
  await m2.down(sequelize.getQueryInterface());
  const [rows] = await sequelize.query("SELECT * FROM planned_events WHERE kind='subscription'");
  assert.equal(rows.length, 0);
});
