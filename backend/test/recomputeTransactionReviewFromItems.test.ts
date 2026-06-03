// backend/test/recomputeTransactionReviewFromItems.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Account,
  Transaction,
  TransactionSignal,
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
} from '../src/models';
import { recomputeTransactionReviewFromItems } from '../src/import/enrichment/recomputeTransactionReviewFromItems';

const HH = 1;
let accountId: number;
let fpCounter = 0;
let orderCounter = 0;

before(async () => {
  await sequelize.sync({ force: true });
  const acct = await Account.create({
    householdId: HH,
    name: 'Card',
    visibility: 'private',
  } as never);
  accountId = acct.id;
});

async function makeItemizedTxn(opts: {
  reviewFlag: boolean;
  signals: Array<{ source: string; confidence: string; fields: Record<string, unknown> }>;
  items: Array<{ inferredCategory: string | null; categoryOverride: string | null; confidence: number | null }>;
}): Promise<number> {
  fpCounter += 1;
  const fp = `fp-${fpCounter}`;
  const txn = await Transaction.create({
    accountId,
    householdId: HH,
    importBatch: 'test',
    date: '2026-05-01',
    amount: '-100.00',
    currency: 'CAD',
    merchantRaw: 'COSTCO',
    merchantClean: 'Costco',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: opts.reviewFlag,
    finalSplitType: 'me',
  } as never);

  for (const s of opts.signals) {
    await TransactionSignal.create({
      transactionId: txn.id,
      source: s.source,
      confidence: s.confidence,
      fields: s.fields,
    } as never);
  }

  orderCounter += 1;
  const order = await ExternalOrder.create({
    householdId: HH,
    vendor: 'costco',
    dedupeKey: `dk-test-${orderCounter}`,
    total: '100.00',
    currency: 'CAD',
    orderDate: '2026-05-01',
    source: 'test',
  } as never);

  for (const it of opts.items) {
    await ExternalOrderItem.create({
      externalOrderId: order.id,
      title: 'x',
      inferredCategory: it.inferredCategory,
      categoryOverride: it.categoryOverride,
      confidence: it.confidence,
    } as never);
  }

  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90',
    matchReason: 'test',
    status: 'accepted',
  } as never);

  return txn.id;
}

test('all items high-confidence -> reviewFlag cleared', async () => {
  const id = await makeItemizedTxn({
    reviewFlag: true,
    signals: [{ source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } }],
    items: [
      { inferredCategory: 'Groceries', categoryOverride: null, confidence: 95 },
      { inferredCategory: 'Household', categoryOverride: null, confidence: 88 },
    ],
  });
  await recomputeTransactionReviewFromItems(id);
  const txn = await Transaction.findByPk(id);
  assert.equal(txn!.reviewFlag, false);
  assert.equal(txn!.importConfidence, 'clean');
});

test('one straggler -> stays in review', async () => {
  const id = await makeItemizedTxn({
    reviewFlag: true,
    signals: [{ source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } }],
    items: [
      { inferredCategory: 'Groceries', categoryOverride: null, confidence: 95 },
      { inferredCategory: 'Household', categoryOverride: null, confidence: 30 },
    ],
  });
  await recomputeTransactionReviewFromItems(id);
  const txn = await Transaction.findByPk(id);
  assert.equal(txn!.reviewFlag, true);
});

test('rule-high baseline stays cleared even with straggler items', async () => {
  const id = await makeItemizedTxn({
    reviewFlag: false,
    signals: [{ source: 'rule', confidence: 'high', fields: { autoCategory: 'Groceries' } }],
    items: [{ inferredCategory: 'Household', categoryOverride: null, confidence: 30 }],
  });
  await recomputeTransactionReviewFromItems(id);
  const txn = await Transaction.findByPk(id);
  assert.equal(txn!.reviewFlag, false);
});

test('removing the override that cleared an item re-flags the transaction', async () => {
  const id = await makeItemizedTxn({
    reviewFlag: true,
    signals: [{ source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } }],
    items: [{ inferredCategory: null, categoryOverride: 'Household', confidence: null }],
  });
  await recomputeTransactionReviewFromItems(id);
  assert.equal((await Transaction.findByPk(id))!.reviewFlag, false);
  // Remove the override that was clearing the item
  await ExternalOrderItem.update({ categoryOverride: null }, { where: {} });
  await recomputeTransactionReviewFromItems(id);
  assert.equal((await Transaction.findByPk(id))!.reviewFlag, true);
});

test('best-effort: unknown txn id does not throw', async () => {
  await recomputeTransactionReviewFromItems(999999);
});
