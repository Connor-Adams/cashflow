import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Account,
  Transaction,
  ExternalOrder,
  ExternalOrderTender,
  TransactionOrderLink,
  AccountCardIdentifier,
} from '../models';
import { matchReceiptOrderToTransactions } from './matchReceiptToTransactions';

const HH = 1;
let accountId: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
  const account = await Account.create({ name: 'Test', householdId: HH } as never);
  accountId = account.id;
});

beforeEach(async () => {
  await AccountCardIdentifier.destroy({ where: {}, force: true });
  await TransactionOrderLink.destroy({ where: {} });
  await ExternalOrderTender.destroy({ where: {} });
  await ExternalOrder.destroy({ where: {} });
  await Transaction.destroy({ where: {} });
});

async function mkTxn(opts: { amount: string; date: string; merchant?: string }): Promise<Transaction> {
  fp += 1;
  return Transaction.create({
    accountId,
    householdId: HH,
    importBatch: 'test',
    date: opts.date,
    merchantRaw: opts.merchant ?? 'COSTCO WHOLESALE W1168 GUELPH ON',
    merchantClean: opts.merchant ?? 'Costco',
    amount: opts.amount,
    currency: 'CAD',
    sourceRowFingerprint: `fp-${fp}`,
    sourceIdentityFingerprint: `sif-${fp}`,
  } as never);
}

async function mkOrder(opts: {
  orderDate: string;
  total: string;
  last4?: string;
  source?: string;
}): Promise<ExternalOrder> {
  return ExternalOrder.create({
    vendor: 'costco',
    householdId: HH,
    dedupeKey: `dk-${opts.orderDate}-${opts.total}`,
    orderDate: opts.orderDate,
    total: opts.total,
    paymentLast4: opts.last4 ?? null,
    currency: 'CAD',
    source: opts.source ?? 'test',
  } as never);
}

test('single exact-amount match → link created accepted', async () => {
  await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04' });

  const res = await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  assert.equal(res.created, 1);
  const links = await TransactionOrderLink.findAll({ where: { externalOrderId: order.id } });
  assert.equal(links.length, 1);
  assert.equal(links[0].status, 'accepted');
});

test('unknown-vendor order (vendor "other") never auto-accepts on amount+date alone', async () => {
  // Regression: txnMatchesVendor passes every txn through for unknown vendors,
  // and the vendor component used to award +15 anyway — auto-accepting any
  // same-amount transaction (50+25+15=90 ≥ 85) for email receipts whose vendor
  // defaulted to 'other'.
  await mkTxn({ amount: '-52.00', date: '2025-12-13', merchant: 'SHELL GAS STATION' });
  const order = await ExternalOrder.create({
    vendor: 'other',
    householdId: HH,
    dedupeKey: 'dk-other-1',
    orderDate: '2025-12-13',
    total: '52.00',
    paymentLast4: null,
    currency: 'CAD',
    source: 'test',
  } as never);

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  const links = await TransactionOrderLink.findAll({ where: { externalOrderId: order.id } });
  assert.equal(links.length, 1, 'still surfaced as a suggestion');
  assert.equal(links[0].status, 'suggested', 'no vendor evidence → must not auto-accept');
});

test('two same-amount candidates in window → ambiguous, stays suggested', async () => {
  await mkTxn({ amount: '-947.04', date: '2025-12-14' });
  await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04' });

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  const links = await TransactionOrderLink.findAll({ where: { externalOrderId: order.id } });
  assert.equal(links.length, 1, 'one tender → one best link');
  assert.equal(links[0].status, 'suggested');
});

test('amount-within-$2-only match (confidence < 85) → suggested', async () => {
  await mkTxn({ amount: '-948.54', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04' });

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  const links = await TransactionOrderLink.findAll({ where: { externalOrderId: order.id } });
  assert.equal(links.length, 1);
  assert.equal(links[0].status, 'suggested');
});

test('re-run upgrades a stale suggested link to accepted', async () => {
  const txn = await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04' });
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90',
    matchReason: 'old',
    status: 'suggested',
    linkedAmount: '947.04',
  } as never);

  const res = await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  assert.equal(res.updated, 1);
  const link = await TransactionOrderLink.findOne({ where: { externalOrderId: order.id } });
  assert.equal(link?.status, 'accepted');
});

test('re-run does NOT downgrade accepted or resurrect rejected', async () => {
  const txn = await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04' });
  await TransactionOrderLink.create({
    transactionId: txn.id, externalOrderId: order.id,
    confidence: '90', matchReason: 'm', status: 'rejected', linkedAmount: '947.04',
  } as never);

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  const link = await TransactionOrderLink.findOne({ where: { externalOrderId: order.id } });
  assert.equal(link?.status, 'rejected', 'rejected link must not be resurrected');
});

test('split-tender: both unambiguous tenders accepted (order-398 shape)', async () => {
  await mkTxn({ amount: '-1863.72', date: '2025-12-27' });
  await mkTxn({ amount: '-1100.00', date: '2025-12-29' });
  const order = await mkOrder({ orderDate: '2025-12-26', total: '2963.72' });
  await ExternalOrderTender.create({ externalOrderId: order.id, sequence: 0, paymentLast4: '3812', amount: '1863.72' } as never);
  await ExternalOrderTender.create({ externalOrderId: order.id, sequence: 1, paymentLast4: null, amount: '1100.00' } as never);

  const res = await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  assert.equal(res.created, 2);
  const links = await TransactionOrderLink.findAll({ where: { externalOrderId: order.id } });
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l.status === 'accepted'), 'both tenders should auto-accept');
});

// docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md, Part 2:
// a receipt tender harvests a card identifier onto the linked transaction's
// account, but ONLY when the order's source is on the deterministic
// allowlist (backend/src/amazon/cardOwnership.ts DETERMINISTIC_RECEIPT_SOURCES).
test('a costco_till_receipt-pdf tender writes an account_card_identifier row', async () => {
  const txn = await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04', source: 'costco_till_receipt-pdf' });
  await ExternalOrderTender.create(
    { externalOrderId: order.id, sequence: 0, paymentLast4: '3114', amount: '947.04' } as never,
  );

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });

  const rows = await AccountCardIdentifier.findAll({ where: { accountId: txn.accountId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last4, '3114');
  assert.equal(rows[0].source, 'receipt_tender');
  assert.equal(rows[0].householdId, HH);
});

// The known production bad datum: an AI misparse ('gmail-scan:ai') produced
// a bogus last-4 on a non-card Uber Eats total. This must write nothing.
test('a gmail-scan:ai-sourced order writes NO account_card_identifier row', async () => {
  await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04', source: 'gmail-scan:ai' });
  await ExternalOrderTender.create(
    { externalOrderId: order.id, sequence: 0, paymentLast4: '9907', amount: '947.04' } as never,
  );

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });

  const rows = await AccountCardIdentifier.findAll({ where: { last4: '9907' } });
  assert.equal(rows.length, 0, 'an AI-extracted last4 must never be harvested');
});

test('re-running the matcher does not duplicate the harvested identifier row', async () => {
  const txn = await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04', source: 'costco_till_receipt-pdf' });
  await ExternalOrderTender.create(
    { externalOrderId: order.id, sequence: 0, paymentLast4: '3114', amount: '947.04' } as never,
  );

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });
  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });

  const rows = await AccountCardIdentifier.findAll({ where: { accountId: txn.accountId, last4: '3114' } });
  assert.equal(rows.length, 1, 'must not duplicate on a repeat run');
});

test('a tender with no paymentLast4 writes no identifier even on a trusted source', async () => {
  await mkTxn({ amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({ orderDate: '2025-12-13', total: '947.04', source: 'costco_till_receipt-pdf' });
  await ExternalOrderTender.create(
    { externalOrderId: order.id, sequence: 0, paymentLast4: null, amount: '947.04' } as never,
  );

  await matchReceiptOrderToTransactions({ externalOrderId: order.id, householdId: HH });

  const rows = await AccountCardIdentifier.findAll({ where: { accountId } });
  assert.equal(rows.length, 0);
});
