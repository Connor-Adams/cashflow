import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-vendor-capture.sqlite');

let models: typeof import('../models/index.js');
let vendorCapture: typeof import('./vendorCapture.js');

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development', GH_PACKAGES_TOKEN: 'dummy' },
    stdio: 'pipe',
  });
  models = await import('../models/index.js');
  vendorCapture = await import('./vendorCapture.js');
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

async function makeHouseholdAndUser() {
  const user = await models.User.create({
    email: `vc-${Date.now()}-${Math.random()}@example.com`,
    displayName: 'VC user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  const household = await models.Household.create({ name: 'VC household' } as never);
  await models.HouseholdMember.create({
    userId: user.id,
    householdId: household.id,
    role: 'owner',
  } as never);
  return { user, household };
}

beforeEach(async () => {
  await models.ExternalOrderItem.destroy({ where: {} });
  await models.ExternalOrder.destroy({ where: {} });
});

test('captureOrders inserts new orders with items', async () => {
  const { user, household } = await makeHouseholdAndUser();
  const result = await vendorCapture.captureOrders({
    householdId: household.id,
    userId: user.id,
    vendor: 'amazon',
    source: 'bookmarklet-amazon-v1',
    orders: [
      {
        vendorOrderId: '112-1111111-1111111',
        orderDate: '2026-05-10',
        total: 25.99,
        currency: 'CAD',
        paymentLast4: '4321',
        items: [{ title: 'USB-C cable', totalPrice: 12.99 }, { title: 'Adapter', totalPrice: 13.00 }],
      },
    ],
  });
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);

  const orders = await models.ExternalOrder.findAll({ include: [{ model: models.ExternalOrderItem, as: 'items' }] });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].vendor, 'amazon');
  assert.equal(orders[0].vendorOrderId, '112-1111111-1111111');
  assert.equal(Number(orders[0].total), 25.99);
  const items = (orders[0] as unknown as { items: unknown[] }).items;
  assert.equal(items.length, 2);
});

test('captureOrders is idempotent on identical payload', async () => {
  const { user, household } = await makeHouseholdAndUser();
  const payload = {
    householdId: household.id,
    userId: user.id,
    vendor: 'amazon',
    source: 'bookmarklet-amazon-v1',
    orders: [
      {
        vendorOrderId: 'O-1',
        orderDate: '2026-05-10',
        total: 9.99,
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'X', totalPrice: 9.99 }],
      },
    ],
  } as const;
  await vendorCapture.captureOrders({ ...payload });
  const second = await vendorCapture.captureOrders({ ...payload });
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 1);
  const count = await models.ExternalOrder.count();
  assert.equal(count, 1);
});

test('captureOrders replaces items when new payload has more items', async () => {
  const { user, household } = await makeHouseholdAndUser();
  const base = {
    householdId: household.id,
    userId: user.id,
    vendor: 'amazon' as const,
    source: 'bookmarklet-amazon-v1',
  };
  await vendorCapture.captureOrders({
    ...base,
    orders: [
      { vendorOrderId: 'O-2', orderDate: '2026-05-10', total: 30, currency: 'CAD', paymentLast4: null, items: [{ title: 'A' }] },
    ],
  });
  const result = await vendorCapture.captureOrders({
    ...base,
    orders: [
      {
        vendorOrderId: 'O-2',
        orderDate: '2026-05-10',
        total: 30,
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
      },
    ],
  });
  assert.equal(result.updated, 1);
  const order = await models.ExternalOrder.findOne({ include: [{ model: models.ExternalOrderItem, as: 'items' }] });
  const items = (order as unknown as { items: { title: string }[] }).items;
  assert.equal(items.length, 3);
  const titles = items.map((it) => it.title).sort();
  assert.deepEqual(titles, ['A', 'B', 'C']);
});

test('captureOrders keeps existing items when new payload has fewer', async () => {
  const { user, household } = await makeHouseholdAndUser();
  const base = {
    householdId: household.id,
    userId: user.id,
    vendor: 'amazon' as const,
    source: 'bookmarklet-amazon-v1',
  };
  await vendorCapture.captureOrders({
    ...base,
    orders: [
      {
        vendorOrderId: 'O-3',
        orderDate: '2026-05-10',
        total: 30,
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'A' }, { title: 'B' }],
      },
    ],
  });
  const result = await vendorCapture.captureOrders({
    ...base,
    orders: [
      {
        vendorOrderId: 'O-3',
        orderDate: '2026-05-10',
        total: 31, // header updated
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'A' }],
      },
    ],
  });
  assert.equal(result.updated, 1);
  const order = await models.ExternalOrder.findOne({ include: [{ model: models.ExternalOrderItem, as: 'items' }] });
  assert.equal(Number(order!.total), 31);
  const items = (order as unknown as { items: { title: string }[] }).items;
  assert.equal(items.length, 2, 'fuller prior capture must be preserved');
});

test('captureOrders rejects empty vendor', async () => {
  const { user, household } = await makeHouseholdAndUser();
  await assert.rejects(() =>
    vendorCapture.captureOrders({
      householdId: household.id,
      userId: user.id,
      vendor: '',
      source: 'bookmarklet-amazon-v1',
      orders: [],
    } as never),
  );
});
