/**
 * Round-trip test for the drop-subscriptions migration (Cashflow #402, finish
 * the Expectation fold). The `subscriptions` table is orphaned — its model is
 * deleted and its data already lives in `planned_events` (kind='subscription',
 * source='recurring_detection'). This migration drops it.
 *
 * `down()` must be reversible: it recreates the table + indexes (mirroring
 * 20260530000002-subscriptions.js) and re-copies the rows back out of
 * planned_events, inverting the status mapping from
 * 20260611000002-expectation-absorb-data.js (planned+uncertain -> 'unknown',
 * planned -> 'active', cancelled -> 'cancelled', ignored -> 'ignored').
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();

  // planned_events as it exists post-fold (subset of columns relevant to the
  // subscription re-copy; price_change_detected was dropped from this table).
  await qi.createTable('planned_events', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'planned' },
    type: { type: DataTypes.STRING(32), allowNull: false },
    source: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'manual' },
    name: { type: DataTypes.STRING(255), allowNull: false },
    normalized_name: { type: DataTypes.STRING(255), allowNull: true },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    cadence: { type: DataTypes.STRING(16), allowNull: true },
    last_charge_date: { type: DataTypes.DATEONLY, allowNull: true },
    next_expected_date: { type: DataTypes.DATEONLY, allowNull: true },
    expected_date: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'planned' },
    status_uncertain: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    category: { type: DataTypes.STRING(128), allowNull: true },
    annualized_cost: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    cancellation_url: { type: DataTypes.TEXT, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // households referenced by the recreated table's logical FK (no real FK, but
  // present for parity with the live schema).
  await qi.createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });

  const now = new Date();
  await sequelize.query('INSERT INTO households (id) VALUES (1)');
  // Subscription rows already folded into planned_events: one active (planned,
  // not uncertain), one from a former 'unknown' (planned + uncertain), one
  // cancelled, one ignored. Plus a non-subscription planned row that must NOT
  // be re-copied into the recreated table.
  await qi.bulkInsert('planned_events', [
    {
      household_id: 1, user_id: 7, kind: 'subscription', type: 'expense',
      source: 'recurring_detection', name: 'Netflix', normalized_name: 'netflix',
      amount: '20.0000', currency: 'CAD', cadence: 'monthly',
      last_charge_date: '2026-05-15', next_expected_date: '2026-06-15',
      expected_date: '2026-06-15', status: 'planned', status_uncertain: false,
      category: 'Streaming', annualized_cost: '240.0000',
      cancellation_url: 'https://netflix.com/cancel', notes: 'family plan',
      created_at: now, updated_at: now,
    },
    {
      household_id: 1, user_id: 7, kind: 'subscription', type: 'expense',
      source: 'recurring_detection', name: 'Gym', normalized_name: 'gym',
      amount: '50.0000', currency: 'CAD', cadence: 'monthly',
      last_charge_date: '2026-05-01', next_expected_date: null,
      expected_date: '2026-05-01', status: 'planned', status_uncertain: true,
      category: null, annualized_cost: '600.0000',
      cancellation_url: null, notes: null, created_at: now, updated_at: now,
    },
    {
      household_id: 1, user_id: 7, kind: 'subscription', type: 'expense',
      source: 'recurring_detection', name: 'Spotify', normalized_name: 'spotify',
      amount: '10.0000', currency: 'CAD', cadence: 'monthly',
      last_charge_date: '2026-04-10', next_expected_date: '2026-05-10',
      expected_date: '2026-05-10', status: 'cancelled', status_uncertain: false,
      category: 'Streaming', annualized_cost: '120.0000',
      cancellation_url: null, notes: null, created_at: now, updated_at: now,
    },
    {
      household_id: 1, user_id: 7, kind: 'subscription', type: 'expense',
      source: 'recurring_detection', name: 'Old Mag', normalized_name: 'old mag',
      amount: '5.0000', currency: 'CAD', cadence: 'monthly',
      last_charge_date: '2026-03-01', next_expected_date: '2026-04-01',
      expected_date: '2026-04-01', status: 'ignored', status_uncertain: false,
      category: null, annualized_cost: '60.0000',
      cancellation_url: null, notes: null, created_at: now, updated_at: now,
    },
    {
      household_id: 1, user_id: 7, kind: 'planned', type: 'expense',
      source: 'manual', name: 'One-off rent', normalized_name: null,
      amount: '2000.0000', currency: 'CAD', cadence: null,
      last_charge_date: null, next_expected_date: null,
      expected_date: '2026-07-01', status: 'planned', status_uncertain: false,
      category: null, annualized_cost: null,
      cancellation_url: null, notes: null, created_at: now, updated_at: now,
    },
  ]);

  // The orphaned table the migration drops. It still physically exists on main.
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
  await qi.addIndex('subscriptions', ['household_id', 'normalized_name', 'currency'], {
    name: 'subscriptions_household_name_currency_unique', unique: true,
  });
  await qi.addIndex('subscriptions', ['household_id', 'status'], {
    name: 'subscriptions_household_status',
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260622000001-drop-subscriptions.js');
});

after(async () => {
  await sequelize.close();
});

test('up drops the orphaned subscriptions table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(!tables.includes('subscriptions'), `Table should be gone, found: ${tables.join(', ')}`);
  // planned_events is untouched.
  const [pe] = await sequelize.query("SELECT COUNT(*) AS c FROM planned_events");
  assert.equal((pe[0] as { c: number }).c, 5);
});

test('down recreates the table with the original schema + indexes', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(tables.includes('subscriptions'), `Table should be back, found: ${tables.join(', ')}`);

  const desc = await sequelize.getQueryInterface().describeTable('subscriptions');
  for (const col of [
    'id', 'household_id', 'merchant_name', 'normalized_name', 'amount', 'currency',
    'cadence', 'last_charge_date', 'next_expected_date', 'status', 'category',
    'annualized_cost', 'price_change_detected', 'cancellation_url', 'notes',
    'created_at', 'updated_at',
  ]) {
    assert.ok(desc[col], `recreated table has ${col}`);
  }

  const indexes = await sequelize.getQueryInterface().showIndex('subscriptions');
  const names = (indexes as { name: string }[]).map((i) => i.name);
  assert.ok(
    names.includes('subscriptions_household_name_currency_unique'),
    `unique index restored, found: ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('subscriptions_household_status'),
    `status index restored, found: ${names.join(', ')}`,
  );
});

test('down re-copies subscription rows out of planned_events with inverse status mapping', async () => {
  const [rows] = await sequelize.query('SELECT * FROM subscriptions ORDER BY merchant_name');
  // Only the 4 kind=subscription rows come back; the 'One-off rent' planned row does not.
  assert.equal(rows.length, 4);

  type Sub = {
    merchant_name: string; normalized_name: string; amount: string; currency: string;
    cadence: string; last_charge_date: string; next_expected_date: string | null;
    status: string; category: string | null; annualized_cost: string;
    price_change_detected: number; cancellation_url: string | null; notes: string | null;
  };
  const byName = (n: string) => (rows as Sub[]).find((r) => r.merchant_name === n)!;

  const netflix = byName('Netflix');
  assert.equal(netflix.normalized_name, 'netflix');
  assert.equal(netflix.status, 'active'); // planned + not uncertain -> active
  assert.equal(netflix.cadence, 'monthly');
  assert.equal(netflix.next_expected_date, '2026-06-15');
  assert.equal(netflix.cancellation_url, 'https://netflix.com/cancel');
  assert.equal(netflix.notes, 'family plan');
  assert.equal(netflix.category, 'Streaming');
  assert.equal(Number(netflix.annualized_cost), 240);
  assert.equal(!!netflix.price_change_detected, false); // not stored post-fold -> defaults false

  const gym = byName('Gym');
  assert.equal(gym.status, 'unknown'); // planned + uncertain -> unknown
  assert.equal(gym.next_expected_date, null);

  assert.equal(byName('Spotify').status, 'cancelled'); // cancelled -> cancelled
  assert.equal(byName('Old Mag').status, 'ignored'); // ignored -> ignored
});

test('up again drops the recreated table cleanly (idempotent round-trip)', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(!tables.includes('subscriptions'), `Table should be gone again, found: ${tables.join(', ')}`);
});
