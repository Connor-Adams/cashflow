// backend/src/summary/loadItemAllocations.categoryId.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import {
  Household,
  ExternalOrder,
  ExternalOrderItem,
  Transaction,
  TransactionOrderLink,
  Account,
} from '../models';
import { loadItemAllocationContext } from './loadItemAllocations';

let householdId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
});

test('context items carry inferredCategoryId / categoryOverrideId', async () => {
  const account = await Account.create({
    householdId,
    name: 'A',
    type: 'chequing',
    currency: 'CAD',
  } as never);
  const txn = await Transaction.create({
    householdId,
    accountId: account.id,
    importBatch: 'test',
    date: '2026-01-01',
    merchantRaw: 'Test',
    merchantClean: 'Test',
    amount: '-100.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-catid-001',
    sourceIdentityFingerprint: 'sif-catid-001',
  } as never);
  const order = await ExternalOrder.create({
    householdId,
    vendor: 'amazon',
    source: 'amazon',
    currency: 'CAD',
    dedupeKey: 'catid-test-order-1',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Milk',
    inferredCategory: 'Groceries',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    status: 'accepted',
    linkedAmount: '-100',
    confidence: '1.0',
    matchReason: 'manual',
  } as never);
  const ctx = await loadItemAllocationContext([txn.id]);
  const items = ctx.itemsByOrder.get(order.id)!;
  assert.ok(items != null && items.length > 0, 'items should exist for the order');
  assert.ok('inferredCategoryId' in items[0]);
  assert.ok('categoryOverrideId' in items[0]);
});
