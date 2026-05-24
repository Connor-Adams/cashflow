import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Account,
  Transaction,
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
} from '../src/models';
import { loadItemAllocationContext } from '../src/summary/loadItemAllocations';

before(async () => {
  await sequelize.sync({ force: true });
});

test('loadItemAllocationContext: returns empty maps when no txn ids', async () => {
  const ctx = await loadItemAllocationContext([]);
  assert.equal(ctx.linksByTxn.size, 0);
  assert.equal(ctx.ordersById.size, 0);
  assert.equal(ctx.itemsByOrder.size, 0);
});

test('loadItemAllocationContext: returns maps keyed by txn id / order id', async () => {
  // Create required parent records for FK constraints
  const account = await Account.create({ name: 'Test Account' } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    importBatch: 'test',
    date: '2026-01-01',
    merchantRaw: 'Costco',
    merchantClean: 'Costco',
    amount: '-100.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-lia-001',
    sourceIdentityFingerprint: 'sif-lia-001',
  } as never);

  const order = await ExternalOrder.create({
    vendor: 'costco',
    dedupeKey: 'k1',
    total: '100.00',
    subtotal: '90.00',
    tax: '10.00',
    currency: 'CAD',
    source: 'test',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Eggs',
    quantity: 1,
    totalPrice: '90.00',
    inferredCategory: 'Groceries',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90',
    matchReason: 'test',
    status: 'confirmed',
    linkedAmount: '100.00',
  } as never);

  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(ctx.linksByTxn.get(txn.id)?.length, 1);
  // Sequelize returns DECIMAL as a number (100) from SQLite in sync({force:true}) context
  assert.ok(ctx.ordersById.has(order.id), 'ordersById should contain the order');
  assert.equal(Number(ctx.ordersById.get(order.id)?.total), 100);
  assert.equal(ctx.itemsByOrder.get(order.id)?.[0]?.inferredCategory, 'Groceries');
});
