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
import { backfillAccountCardIdentifiers } from './cardIdentifierBackfill';

const HH = 1;
let costcoAccountId: number;
let amexAccountId: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
  const costco = await Account.create({
    name: 'Costco MC',
    householdId: HH,
    shortCode: 'costco',
  } as never);
  costcoAccountId = costco.id;
  const amex = await Account.create({
    name: 'Amex Reserve',
    householdId: HH,
    shortCode: '701001',
  } as never);
  amexAccountId = amex.id;
});

beforeEach(async () => {
  await AccountCardIdentifier.destroy({ where: {}, force: true });
  await TransactionOrderLink.destroy({ where: {} });
  await ExternalOrderTender.destroy({ where: {} });
  await ExternalOrder.destroy({ where: {}, force: true });
  await Transaction.destroy({ where: {} });
});

async function mkTxn(accountId: number, opts: { amount: string; date: string }): Promise<Transaction> {
  fp += 1;
  return Transaction.create({
    accountId,
    householdId: HH,
    importBatch: 'test',
    date: opts.date,
    merchantRaw: 'TEST MERCHANT',
    merchantClean: 'Test',
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
  source: string;
  vendor?: string;
}): Promise<ExternalOrder> {
  return ExternalOrder.create({
    vendor: opts.vendor ?? 'costco',
    householdId: HH,
    dedupeKey: `dk-${Math.random()}`,
    orderDate: opts.orderDate,
    total: opts.total,
    paymentLast4: opts.last4 ?? null,
    currency: 'CAD',
    source: opts.source,
  } as never);
}

async function mkLink(opts: {
  transactionId: number;
  externalOrderId: number;
  linkedAmount?: string;
  status?: string;
}): Promise<TransactionOrderLink> {
  return TransactionOrderLink.create({
    transactionId: opts.transactionId,
    externalOrderId: opts.externalOrderId,
    confidence: '95',
    matchReason: 'test',
    status: opts.status ?? 'accepted',
    linkedAmount: opts.linkedAmount ?? null,
  } as never);
}

test('a costco till-receipt tender linked to an account-5-shaped transaction yields exactly one identifier', async () => {
  const txn = await mkTxn(costcoAccountId, { amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({
    orderDate: '2025-12-13',
    total: '947.04',
    source: 'costco_till_receipt-pdf',
  });
  await ExternalOrderTender.create(
    { externalOrderId: order.id, sequence: 0, paymentLast4: '3114', amount: '947.04' } as never,
  );
  await mkLink({ transactionId: txn.id, externalOrderId: order.id, linkedAmount: '947.04' });

  const report = await backfillAccountCardIdentifiers();

  const rows = await AccountCardIdentifier.findAll({ where: { accountId: costcoAccountId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last4, '3114');
  assert.equal(rows[0].source, 'backfill:costco_till_receipt-pdf');
  assert.equal(report.dryRun, false);
  assert.equal(report.newRows.length, 1);
});

test('an AI-sourced (gmail-scan:ai) 9907 on an Uber Eats order yields NONE', async () => {
  const txn = await mkTxn(amexAccountId, { amount: '-32.50', date: '2025-11-01' });
  const order = await mkOrder({
    orderDate: '2025-10-30',
    total: '32.50',
    source: 'gmail-scan:ai',
    vendor: 'uber_eats',
  });
  await ExternalOrderTender.create(
    { externalOrderId: order.id, sequence: 0, paymentLast4: '9907', amount: '32.50' } as never,
  );
  await mkLink({ transactionId: txn.id, externalOrderId: order.id, linkedAmount: '32.50' });

  await backfillAccountCardIdentifiers();

  const rows = await AccountCardIdentifier.findAll({ where: { last4: '9907' } });
  assert.equal(rows.length, 0, 'an AI-extracted last4 must never be harvested by the backfill');
});

test('re-running the backfill writes nothing new and does not duplicate', async () => {
  const txn = await mkTxn(costcoAccountId, { amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({
    orderDate: '2025-12-13',
    total: '947.04',
    source: 'costco_till_receipt-pdf',
  });
  await ExternalOrderTender.create(
    { externalOrderId: order.id, sequence: 0, paymentLast4: '3114', amount: '947.04' } as never,
  );
  await mkLink({ transactionId: txn.id, externalOrderId: order.id, linkedAmount: '947.04' });

  await backfillAccountCardIdentifiers();
  const second = await backfillAccountCardIdentifiers();

  const rows = await AccountCardIdentifier.findAll({
    where: { accountId: costcoAccountId, last4: '3114' },
  });
  assert.equal(rows.length, 1, 'must not duplicate on a repeat run');
  assert.equal(second.newRows.length, 0, 'second run must report nothing new');
});

test('dryRun: true writes nothing at all but reports what it would do', async () => {
  const txn = await mkTxn(costcoAccountId, { amount: '-947.04', date: '2025-12-15' });
  const order = await mkOrder({
    orderDate: '2025-12-13',
    total: '947.04',
    source: 'costco_till_receipt-pdf',
  });
  await ExternalOrderTender.create(
    { externalOrderId: order.id, sequence: 0, paymentLast4: '3114', amount: '947.04' } as never,
  );
  await mkLink({ transactionId: txn.id, externalOrderId: order.id, linkedAmount: '947.04' });

  const report = await backfillAccountCardIdentifiers({ dryRun: true });

  const rows = await AccountCardIdentifier.findAll({ where: { accountId: costcoAccountId } });
  assert.equal(rows.length, 0, 'dry run must write nothing');
  assert.equal(report.dryRun, true);
  assert.equal(report.newRows.length, 1);
  assert.equal(report.newRows[0].last4, '3114');
  assert.equal(report.newRows[0].accountId, costcoAccountId);
});

test('an order with no tender rows falls back to order.paymentLast4', async () => {
  const txn = await mkTxn(costcoAccountId, { amount: '-100.00', date: '2025-06-01' });
  const order = await mkOrder({
    orderDate: '2025-05-30',
    total: '100.00',
    last4: '3114',
    source: 'costco_till_receipt-pdf',
  });
  await mkLink({ transactionId: txn.id, externalOrderId: order.id, linkedAmount: '100.00' });

  const report = await backfillAccountCardIdentifiers();

  const rows = await AccountCardIdentifier.findAll({ where: { accountId: costcoAccountId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last4, '3114');
  assert.equal(report.newRows.length, 1);
});

test('a non-allowlisted source produces no candidates even with a tender and a link', async () => {
  const txn = await mkTxn(amexAccountId, { amount: '-10.00', date: '2025-01-01' });
  const order = await mkOrder({
    orderDate: '2024-12-30',
    total: '10.00',
    source: 'email-paste',
  });
  await ExternalOrderTender.create(
    { externalOrderId: order.id, sequence: 0, paymentLast4: '4321', amount: '10.00' } as never,
  );
  await mkLink({ transactionId: txn.id, externalOrderId: order.id, linkedAmount: '10.00' });

  const report = await backfillAccountCardIdentifiers();

  assert.equal(report.newRows.length, 0);
  const rows = await AccountCardIdentifier.findAll({ where: { last4: '4321' } });
  assert.equal(rows.length, 0);
});
