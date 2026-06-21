import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, ExternalOrder, ExternalOrderItem, TransactionOrderLink, Transaction, TransactionSignal, Household } from '../models';
import { supersedeAcceptedOrderLinks, linkOrderToTransaction, anchorReceiptOrderToTransaction } from './receiptOrderAnchor';
import type { ReceiptOpenAiCaller } from './categorizeReceiptItems';

const HH = 1;
let accountId: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
  // The ExternalOrderItem beforeSave hook calls resolveCategoryIdByName which
  // does Category.findOrCreate — categories.household_id has a FK to households.
  await Household.create({ name: 'H' } as never);
  const acct = await Account.create({ householdId: HH, name: 'Card', visibility: 'private' } as never);
  accountId = acct.id;
});

async function txn(): Promise<number> {
  fp += 1;
  const t = await Transaction.create({
    accountId, householdId: HH, importBatch: 'test', date: '2026-05-01', amount: '-10.00',
    currency: 'CAD', merchantRaw: 'M', merchantClean: 'M', sourceRowFingerprint: `f${fp}`,
    sourceIdentityFingerprint: `f${fp}`, txnType: 'purchase', reviewFlag: true, finalSplitType: 'me',
  } as never);
  return t.id;
}
async function order(): Promise<number> {
  fp += 1;
  const o = await ExternalOrder.create({
    householdId: HH, vendor: 'other', dedupeKey: `dk${fp}`, total: '10.00', currency: 'CAD',
    orderDate: '2026-05-01', source: 'receipt-analyze',
  } as never);
  return o.id;
}

test('linkOrderToTransaction creates an accepted link, idempotent', async () => {
  const t = await txn(); const o = await order();
  await linkOrderToTransaction(o, t);
  await linkOrderToTransaction(o, t);
  const links = await TransactionOrderLink.findAll({ where: { transactionId: t, externalOrderId: o } });
  assert.equal(links.length, 1);
  assert.equal((links[0] as unknown as { status: string }).status, 'accepted');
});

test('linkOrderToTransaction promotes an existing suggested link to accepted', async () => {
  const t = await txn(); const o = await order();
  await TransactionOrderLink.create({ transactionId: t, externalOrderId: o, status: 'suggested', confidence: '50', matchReason: 'fuzzy' } as never);
  await linkOrderToTransaction(o, t);
  const link = await TransactionOrderLink.findOne({ where: { transactionId: t, externalOrderId: o } });
  assert.equal((link as unknown as { status: string }).status, 'accepted');
});

test('supersedeAcceptedOrderLinks rejects other accepted links but keeps the kept order', async () => {
  const t = await txn(); const oldO = await order(); const keep = await order();
  await TransactionOrderLink.create({ transactionId: t, externalOrderId: oldO, status: 'accepted', confidence: '90', matchReason: 'amazon' } as never);
  await TransactionOrderLink.create({ transactionId: t, externalOrderId: keep, status: 'accepted', confidence: '100', matchReason: 'receipt-attach' } as never);
  await supersedeAcceptedOrderLinks(t, keep);
  const oldLink = await TransactionOrderLink.findOne({ where: { transactionId: t, externalOrderId: oldO } });
  const keepLink = await TransactionOrderLink.findOne({ where: { transactionId: t, externalOrderId: keep } });
  assert.equal((oldLink as unknown as { status: string }).status, 'rejected');
  assert.equal((keepLink as unknown as { status: string }).status, 'accepted');
});

// ── anchorReceiptOrderToTransaction tests ──────────────────────────────────────

/** Returns an OpenAiJsonResult with no items (bypasses AI network calls). */
const emptyCaller: ReceiptOpenAiCaller = async (_messages, _options) => ({
  json: { items: [] },
  model: 'test',
  temperature: 0,
  latencyMs: 0,
  providerRequestId: null,
  rawTextPreview: '',
});

async function reviewableTxn(): Promise<number> {
  const t = await txn(); // reviewFlag=true from helper
  await TransactionSignal.create({
    transactionId: t, source: 'item-link', confidence: 'medium',
    fields: { autoCategory: 'Mixed' },
  } as never);
  return t;
}

async function orderWithItems(
  items: Array<{ inferredCategory: string | null; confidence: number | null }>,
): Promise<number> {
  const o = await order();
  for (const it of items) {
    await ExternalOrderItem.create({
      externalOrderId: o, title: 'x', quantity: 1,
      inferredCategory: it.inferredCategory,
      categoryOverride: null,
      confidence: it.confidence != null ? String(it.confidence) : null,
    } as never);
  }
  return o;
}

test('anchor: links order to txn, high-confidence items clear review, returns itemCount', async () => {
  const t = await reviewableTxn();
  const o = await orderWithItems([
    { inferredCategory: 'Groceries', confidence: 90 },
    { inferredCategory: 'Household', confidence: 85 },
  ]);
  const res = await anchorReceiptOrderToTransaction(
    { orderId: o, transactionId: t, householdId: HH },
    { openaiCaller: emptyCaller },
  );
  assert.equal(res.itemCount, 2);
  const link = await TransactionOrderLink.findOne({ where: { transactionId: t, externalOrderId: o } });
  assert.equal((link as unknown as { status: string }).status, 'accepted');
  assert.equal((await Transaction.findByPk(t))!.reviewFlag, false);
});

test('anchor: supersedes a prior accepted (amazon) link on the txn', async () => {
  const t = await reviewableTxn();
  const amazon = await order();
  await TransactionOrderLink.create({
    transactionId: t, externalOrderId: amazon, status: 'accepted', confidence: '90', matchReason: 'amazon',
  } as never);
  const o = await orderWithItems([{ inferredCategory: 'Groceries', confidence: 90 }]);
  await anchorReceiptOrderToTransaction(
    { orderId: o, transactionId: t, householdId: HH },
    { openaiCaller: emptyCaller },
  );
  assert.equal(
    (await TransactionOrderLink.findOne({ where: { transactionId: t, externalOrderId: amazon } }) as unknown as { status: string }).status,
    'rejected',
  );
  assert.equal(
    (await TransactionOrderLink.findOne({ where: { transactionId: t, externalOrderId: o } }) as unknown as { status: string }).status,
    'accepted',
  );
});

test('anchor: zero-item order leaves txn in review and returns itemCount 0', async () => {
  const t = await reviewableTxn();
  const o = await order(); // no items
  const res = await anchorReceiptOrderToTransaction(
    { orderId: o, transactionId: t, householdId: HH },
    { openaiCaller: emptyCaller },
  );
  assert.equal(res.itemCount, 0);
  assert.equal((await Transaction.findByPk(t))!.reviewFlag, true);
});

test('anchor: low-confidence item keeps txn in review (straggler)', async () => {
  const t = await reviewableTxn();
  const o = await orderWithItems([{ inferredCategory: 'Groceries', confidence: 30 }]);
  await anchorReceiptOrderToTransaction(
    { orderId: o, transactionId: t, householdId: HH },
    { openaiCaller: emptyCaller },
  );
  assert.equal((await Transaction.findByPk(t))!.reviewFlag, true);
});

test('anchor: re-anchor same order is idempotent (no duplicate link, no double-count)', async () => {
  const t = await reviewableTxn()
  const o = await orderWithItems([{ inferredCategory: 'Groceries', confidence: 90 }])
  await anchorReceiptOrderToTransaction({ orderId: o, transactionId: t, householdId: HH }, { openaiCaller: emptyCaller })
  await anchorReceiptOrderToTransaction({ orderId: o, transactionId: t, householdId: HH }, { openaiCaller: emptyCaller })
  const links = await TransactionOrderLink.findAll({ where: { transactionId: t, externalOrderId: o } })
  assert.equal(links.length, 1)
  assert.equal((links[0] as unknown as { status: string }).status, 'accepted')
})
