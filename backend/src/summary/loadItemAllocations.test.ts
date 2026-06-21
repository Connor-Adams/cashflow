import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Account,
  Transaction,
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
} from '../models';
import { loadItemAllocationContext } from './loadItemAllocations';

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
    status: 'accepted',
    linkedAmount: '100.00',
  } as never);

  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(ctx.linksByTxn.get(txn.id)?.length, 1);
  // Sequelize returns DECIMAL as a number (100) from SQLite in sync({force:true}) context
  assert.ok(ctx.ordersById.has(order.id), 'ordersById should contain the order');
  assert.equal(Number(ctx.ordersById.get(order.id)?.total), 100);
  assert.equal(ctx.itemsByOrder.get(order.id)?.[0]?.inferredCategory, 'Groceries');
});

test('loadItemAllocationContext: excludes suggested and rejected links', async () => {
  const account = await Account.create({ name: 'Status Account' } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    importBatch: 'test',
    date: '2026-01-02',
    merchantRaw: 'Amazon',
    merchantClean: 'Amazon',
    amount: '-100.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-lia-002',
    sourceIdentityFingerprint: 'sif-lia-002',
  } as never);

  const mkOrder = async (key: string) => {
    const order = await ExternalOrder.create({
      vendor: 'amazon',
      dedupeKey: key,
      total: '100.00',
      subtotal: '100.00',
      currency: 'CAD',
      source: 'test',
    } as never);
    await ExternalOrderItem.create({
      externalOrderId: order.id,
      title: 'Widget',
      quantity: 1,
      totalPrice: '100.00',
      inferredCategory: 'Shopping',
    } as never);
    return order;
  };
  const accepted = await mkOrder('k-accepted');
  const suggested = await mkOrder('k-suggested');
  const rejected = await mkOrder('k-rejected');
  for (const [order, status] of [
    [accepted, 'accepted'],
    [suggested, 'suggested'],
    [rejected, 'rejected'],
  ] as const) {
    await TransactionOrderLink.create({
      transactionId: txn.id,
      externalOrderId: order.id,
      confidence: '90',
      matchReason: 'test',
      status,
      linkedAmount: '100.00',
    } as never);
  }

  const ctx = await loadItemAllocationContext([txn.id]);
  // Only the accepted link may feed splitTxnByItems — a stale suggested or
  // superseded/rejected link would double-count the txn across categories.
  assert.equal(ctx.linksByTxn.get(txn.id)?.length, 1);
  assert.equal(ctx.linksByTxn.get(txn.id)?.[0]?.externalOrderId, accepted.id);
  assert.equal(ctx.ordersById.has(suggested.id), false);
  assert.equal(ctx.ordersById.has(rejected.id), false);
});
