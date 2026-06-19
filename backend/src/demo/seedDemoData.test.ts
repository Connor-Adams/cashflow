import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let seedDemoData: typeof import('./seedDemoData').seedDemoData;

before(async () => {
  models = await import('../models');
  ({ seedDemoData } = await import('./seedDemoData'));
  await models.sequelize.sync({ force: true });
  await seedDemoData();
});
after(async () => {
  await models.sequelize.close();
});

test('seed attaches every Amazon order to a transaction via a Receipt', async () => {
  const { Receipt, ExternalOrder } = models;
  const orderCount = await ExternalOrder.count();
  const receipts = await Receipt.findAll({ where: { externalOrderId: { [Op.ne]: null } } });
  assert.equal(orderCount, 5, 'expected 5 seeded Amazon orders');
  assert.equal(receipts.length, 5, 'expected one receipt per order');
  for (const r of receipts) {
    assert.ok(r.transactionId, 'receipt must link to a transaction');
    assert.ok(r.storedFilename && r.originalName && r.mimeType, 'receipt must carry file metadata');
  }
});

test('/api/items: every order resolves to a visible transaction with items', async () => {
  // Mirror routes/items.ts loadOrderAttribution: Receipt -> Transaction join.
  const { Receipt, Transaction, ExternalOrderItem } = models;
  const receipts = await Receipt.findAll({
    where: { externalOrderId: { [Op.ne]: null } },
    include: [{ model: Transaction, as: 'transaction', required: true }],
  });
  const orderIds = receipts.map((r) => r.externalOrderId).filter((x): x is number => x != null);
  const items = await ExternalOrderItem.findAll({
    where: { externalOrderId: { [Op.in]: orderIds } },
  });
  assert.ok(orderIds.length >= 5, 'all orders must be attributed to a visible txn');
  assert.ok(items.length >= 5, '/api/items must return rows');
});

test('drawer: one transaction carries two receipts (multi-receipt layout)', async () => {
  // Mirror GET /api/transactions/:id/receipts grouping by transactionId.
  const { Receipt, ExternalOrderItem } = models;
  const receipts = await Receipt.findAll();
  const byTxn = new Map<number, number>();
  for (const r of receipts) byTxn.set(r.transactionId, (byTxn.get(r.transactionId) ?? 0) + 1);
  const multi = [...byTxn.entries()].find(([, n]) => n >= 2);
  assert.ok(multi, 'expected a transaction with >= 2 receipts');

  const [txnId] = multi!;
  const txnReceipts = await Receipt.findAll({ where: { transactionId: txnId } });
  const orderIds = txnReceipts
    .map((r) => r.externalOrderId)
    .filter((x): x is number => x != null);
  const items = await ExternalOrderItem.findAll({
    where: { externalOrderId: { [Op.in]: orderIds } },
  });
  assert.equal(txnReceipts.length, 2, 'multi-receipt txn should have exactly 2 receipts');
  assert.ok(items.length >= 2, 'multi-receipt drawer must surface items from both receipts');
});
