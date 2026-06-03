import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Account,
  Transaction,
  ExternalOrder,
  ExternalOrderTender,
  TransactionOrderLink,
} from '../src/models';
import { matchReceiptOrderToTransactions } from '../src/import/matchReceiptToTransactions';

const HH = 1;
let accountId: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
  const account = await Account.create({ name: 'Test', householdId: HH } as never);
  accountId = account.id;
});

beforeEach(async () => {
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

async function mkOrder(opts: { orderDate: string; total: string; last4?: string }): Promise<ExternalOrder> {
  return ExternalOrder.create({
    vendor: 'costco',
    householdId: HH,
    dedupeKey: `dk-${opts.orderDate}-${opts.total}`,
    orderDate: opts.orderDate,
    total: opts.total,
    paymentLast4: opts.last4 ?? null,
    currency: 'CAD',
    source: 'test',
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
