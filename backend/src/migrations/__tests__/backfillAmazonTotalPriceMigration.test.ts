/**
 * Round-trip + idempotency test for migration
 * 20260620000003-backfill-amazon-total-price (issue #629, follow-up to #557).
 *
 * Spins up an in-memory SQLite DB, stubs the columns of external_orders /
 * external_order_items the migration touches, seeds a corrupted order matching
 * the real prod shapes (order 49 / 45 / 310 from the #557 audit), runs `up`,
 * asserts the totals are corrected, then runs `up` AGAIN to prove idempotency,
 * and runs `down` to prove it is a non-destructive no-op.
 *
 * Corruption shapes covered:
 *   - Order 49: 2 items, both total_price = shipment subtotal 214.98 (should be
 *     14.99 and 199.99); order subtotal over-counted.
 *   - Order 45: 7 items across shipments, subtotal = first row only; one row has
 *     quantity 0 (must floor to 1).
 *   - Order 310: total = 0, subtotal NULL, single priced item 1609.99 (total
 *     must fall back to the item sum).
 *   - Control: a correct order that must be left UNTOUCHED.
 *   - Non-amazon-report order: must be ignored entirely.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

async function seed() {
  // external_orders
  await sequelize.query(
    `INSERT INTO external_orders (id, vendor, source, subtotal, total, currency, dedupe_key) VALUES
       (49,  'amazon', 'amazon_report', '429.96', '244.93', 'CAD', 'k49'),
       (45,  'amazon', 'amazon_report', '279.99', '316.39', 'CAD', 'k45'),
       (310, 'amazon', 'amazon_report', NULL,     '0',      'CAD', 'k310'),
       (700, 'amazon', 'amazon_report', '25.00',  '25.00',  'CAD', 'k700'),
       (800, 'amazon', 'pdf',           '999.99', '0',      'CAD', 'k800')`,
  );
  // external_order_items: (order, unit_price, total_price[corrupted], quantity)
  await sequelize.query(
    `INSERT INTO external_order_items (external_order_id, title, unit_price, total_price, quantity) VALUES
       -- order 49: both lines wrongly hold the shipment subtotal 214.98
       (49,  'HDMI Cable',    '14.99',   '214.98', 1),
       (49,  'Nvidia Shield', '199.99',  '214.98', 1),
       -- order 45: 7 lines; one has quantity 0 (floors to 1). total_price wrong.
       (45,  'Part 0', '279.99', '279.99', 1),
       (45,  'Part 1', '9.99',   '279.99', 1),
       (45,  'Part 2', '229.98', '279.99', 1),
       (45,  'Part 3', '179.99', '417.97', 0),
       (45,  'Part 4', '74.99',  '417.97', 1),
       (45,  'Part 5', '222.98', '417.97', 1),
       (45,  'Part 6', '120.00', '417.97', 1),
       -- order 310: single priced item, order total 0
       (310, 'Garmin tactix 7', '1609.99', '0', 0),
       -- order 700: ALREADY CORRECT — must be left untouched
       (700, 'Correct widget', '25.00', '25.00', 1),
       -- order 800: pdf source — must be ignored
       (800, 'Pdf item', '500.00', '999.99', 2)`,
  );
}

function near(actual: unknown, expected: number, msg?: string) {
  const n = Number(actual);
  assert.ok(
    Number.isFinite(n) && Math.abs(n - expected) < 0.011,
    `${msg ?? ''} expected ~${expected}, got ${String(actual)}`,
  );
}

async function orderRow(id: number) {
  const [rows] = (await sequelize.query(
    `SELECT subtotal, total FROM external_orders WHERE id = ${id}`,
  )) as [Array<{ subtotal: string | null; total: string | null }>, unknown];
  return rows[0];
}

async function itemTotals(orderId: number) {
  const [rows] = (await sequelize.query(
    `SELECT title, total_price FROM external_order_items WHERE external_order_id = ${orderId} ORDER BY id`,
  )) as [Array<{ title: string; total_price: string | null }>, unknown];
  return rows;
}

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('external_orders', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    vendor: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'amazon' },
    source: { type: DataTypes.STRING(32), allowNull: false },
    dedupe_key: { type: DataTypes.STRING(256), allowNull: false },
    subtotal: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    total: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'CAD' },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  });
  await qi.createTable('external_order_items', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    external_order_id: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING(1024), allowNull: false },
    unit_price: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    total_price: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  });
  await seed();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260620000003-backfill-amazon-total-price.js');
});

after(async () => {
  await sequelize.close();
});

test('up: order 49 per-item line totals become distinct unit*qty', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const items = await itemTotals(49);
  near(items[0].total_price, 14.99, 'HDMI line total');
  near(items[1].total_price, 199.99, 'Shield line total');
  const order = await orderRow(49);
  near(order.subtotal, 214.98, 'order 49 subtotal == Σ lines');
});

test('up: order 45 subtotal aggregates all rows; qty 0 floors to 1', async () => {
  const lineSum = 279.99 + 9.99 + 229.98 + 179.99 + 74.99 + 222.98 + 120.0; // 1117.92
  const order = await orderRow(45);
  near(order.subtotal, lineSum, 'order 45 subtotal == Σ(unit*max(1,qty))');
  // qty-0 row (Part 3) must floor to 1 → 179.99, not 0.
  const items = await itemTotals(45);
  const part3 = items.find((i) => i.title === 'Part 3');
  near(part3?.total_price, 179.99, 'Part 3 qty-0 floors to 1');
  // total had a real non-zero stored value (316.39) → preserved, not clobbered.
  near(order.total, 316.39, 'order 45 real total preserved');
});

test('up: order 310 total falls back to item sum when stored total is 0', async () => {
  const order = await orderRow(310);
  near(order.total, 1609.99, 'order 310 total falls back to item sum');
  near(order.subtotal, 1609.99, 'order 310 subtotal == item sum');
  const items = await itemTotals(310);
  near(items[0].total_price, 1609.99, 'garmin line total');
});

test('up: already-correct order 700 is left untouched', async () => {
  const order = await orderRow(700);
  near(order.subtotal, 25.0, 'order 700 subtotal unchanged');
  near(order.total, 25.0, 'order 700 total unchanged');
  const items = await itemTotals(700);
  near(items[0].total_price, 25.0, 'order 700 item unchanged');
});

test('up: non amazon_report order (pdf) is ignored', async () => {
  const order = await orderRow(800);
  // subtotal/total untouched, item total_price untouched (stays divergent 999.99)
  near(order.subtotal, 999.99, 'pdf order subtotal untouched');
  const items = await itemTotals(800);
  near(items[0].total_price, 999.99, 'pdf item total_price untouched');
});

test('up is idempotent: a second run produces identical values', async () => {
  const before49 = await itemTotals(49);
  const before45 = await orderRow(45);
  const before310 = await orderRow(310);

  await migration.up(sequelize.getQueryInterface(), Sequelize);

  const after49 = await itemTotals(49);
  const after45 = await orderRow(45);
  const after310 = await orderRow(310);

  assert.deepEqual(after49, before49, 'order 49 items stable on re-run');
  assert.deepEqual(after45, before45, 'order 45 totals stable on re-run');
  assert.deepEqual(after310, before310, 'order 310 totals stable on re-run');
});

test('down: is a non-destructive no-op (rows survive)', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const [rows] = (await sequelize.query(
    `SELECT COUNT(*) AS c FROM external_orders`,
  )) as [Array<{ c: number }>, unknown];
  assert.equal(Number(rows[0].c), 5, 'down deletes nothing');
  // Corrected values remain (forward-only).
  const order = await orderRow(310);
  near(order.total, 1609.99, 'down leaves corrected total in place');
});
