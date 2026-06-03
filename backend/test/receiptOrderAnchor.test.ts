import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, ExternalOrder, TransactionOrderLink, Transaction } from '../src/models';
import { supersedeAcceptedOrderLinks, linkOrderToTransaction } from '../src/import/receiptOrderAnchor';

const HH = 1;
let accountId: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
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
