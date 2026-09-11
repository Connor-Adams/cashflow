// backend/src/amazon/mergeDuplicateOrders.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import {
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
  Transaction,
  Household,
  Account,
} from '../models';
import { mergeDuplicateAmazonOrders } from './mergeDuplicateOrders';

before(async () => {
  await sequelize.sync({ force: true });
});

async function seedPair(householdId: number, vendorOrderId = '701-6488283-5477862') {
  const report = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `r-${householdId}`, orderDate: '2025-08-27', total: '10.11', currency: 'CAD',
    paymentLast4: '1001', source: 'amazon_report',
  } as never);
  const email = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `e-${householdId}`, orderDate: null, total: '38.26', currency: 'CAD',
    paymentLast4: null, source: 'gmail-scan:ai',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: report.id, title: 'Widget', quantity: 1,
    unitPrice: '10.11', totalPrice: '10.11',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: email.id, title: 'Gadget', quantity: 1,
    unitPrice: '28.15', totalPrice: '28.15',
  } as never);
  return { report, email };
}

test('the larger email total wins over the partial CSV total', async () => {
  const householdId = 1;
  const { report } = await seedPair(householdId);
  const out = await mergeDuplicateAmazonOrders({ householdId });
  assert.equal(out.merged, 1);

  const survivors = await ExternalOrder.findAll({
    where: { householdId, vendorOrderId: '701-6488283-5477862' },
  });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].id, report.id, 'the older row survives, carrying merged values');
  assert.equal(Number(survivors[0].total), 38.26);
});

test('non-null order date and last4 survive the merge', async () => {
  const householdId = 2;
  await seedPair(householdId);
  await mergeDuplicateAmazonOrders({ householdId });
  const survivor = await ExternalOrder.findOne({
    where: { householdId, vendorOrderId: '701-6488283-5477862' },
  });
  assert.equal(survivor?.orderDate, '2025-08-27', 'from the report row');
  assert.equal(survivor?.paymentLast4, '1001', 'from the report row');
});

test('items are unioned onto the survivor', async () => {
  const householdId = 3;
  await seedPair(householdId);
  await mergeDuplicateAmazonOrders({ householdId });
  const survivor = await ExternalOrder.findOne({
    where: { householdId, vendorOrderId: '701-6488283-5477862' },
  });
  const items = await ExternalOrderItem.findAll({ where: { externalOrderId: survivor!.id } });
  assert.deepEqual(items.map((i) => i.title).sort(), ['Gadget', 'Widget']);
});

test('orders without a vendorOrderId are left alone', async () => {
  const householdId = 4;
  await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId: null, dedupeKey: 'n1',
    orderDate: '2025-08-27', total: '5.00', currency: 'CAD', source: 'gmail-scan:ai',
  } as never);
  await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId: null, dedupeKey: 'n2',
    orderDate: '2025-08-27', total: '5.00', currency: 'CAD', source: 'gmail-scan:ai',
  } as never);

  const out = await mergeDuplicateAmazonOrders({ householdId });
  assert.equal(out.merged, 0);
  assert.equal(await ExternalOrder.count({ where: { householdId, vendorOrderId: null } }), 2);
});

test('running the merge twice leaves one order with the same item set (idempotent)', async () => {
  const householdId = 5;
  await seedPair(householdId);
  const first = await mergeDuplicateAmazonOrders({ householdId });
  assert.equal(first.merged, 1);

  const second = await mergeDuplicateAmazonOrders({ householdId });
  assert.equal(second.merged, 0, 'nothing left to fold on the second pass');

  const survivors = await ExternalOrder.findAll({
    where: { householdId, vendorOrderId: '701-6488283-5477862' },
  });
  assert.equal(survivors.length, 1);
  assert.equal(Number(survivors[0].total), 38.26);

  const items = await ExternalOrderItem.findAll({ where: { externalOrderId: survivors[0].id } });
  assert.deepEqual(items.map((i) => i.title).sort(), ['Gadget', 'Widget'], 'no duplicate items from a second pass');
});

// ─── TransactionOrderLink re-pointing ────────────────────────────────────────

async function seedHouseholdWithTxn(householdId: number) {
  await Household.create({ id: householdId, name: `HH-${householdId}` } as never);
  const account = await Account.create({ householdId, name: 'Test Account' } as never);
  const txn = await Transaction.create({
    householdId, accountId: account.id, date: '2025-08-28',
    amount: '-38.26', currency: 'CAD',
    merchantRaw: 'AMZN MKTP CA*ABC', merchantClean: 'Amazon', txnType: 'purchase',
    importBatch: 'test', sourceRowFingerprint: `srfp-${householdId}`, sourceIdentityFingerprint: `sifp-${householdId}`,
  } as never);
  return { txn };
}

test('a link on the losing order is re-pointed at the survivor, not destroyed', async () => {
  const householdId = 6;
  const { report, email } = await seedPair(householdId);
  const { txn } = await seedHouseholdWithTxn(householdId);

  // Simulate a user having already accepted a match against the EMAIL row
  // (the row that is about to be folded away) before this merge existed.
  await TransactionOrderLink.create({
    transactionId: txn.id, externalOrderId: email.id,
    confidence: '100', matchReason: 'manually linked by user', status: 'accepted',
  } as never);

  await mergeDuplicateAmazonOrders({ householdId });

  const links = await TransactionOrderLink.findAll({ where: { transactionId: txn.id } });
  assert.equal(links.length, 1, 'the link must survive the merge, re-pointed rather than dropped');
  assert.equal(links[0].externalOrderId, report.id);
  assert.equal(links[0].status, 'accepted', 'the user\'s prior acceptance must not be lost');
});

test('a link conflict on the same transaction keeps the higher-precedence link', async () => {
  const householdId = 7;
  const { report, email } = await seedPair(householdId);
  const { txn } = await seedHouseholdWithTxn(householdId);

  // A weak suggestion already exists against the survivor...
  await TransactionOrderLink.create({
    transactionId: txn.id, externalOrderId: report.id,
    confidence: '50', matchReason: 'weak guess', status: 'suggested',
  } as never);
  // ...but the user actually accepted the match against the loser.
  await TransactionOrderLink.create({
    transactionId: txn.id, externalOrderId: email.id,
    confidence: '100', matchReason: 'manually linked by user', status: 'accepted',
  } as never);

  await mergeDuplicateAmazonOrders({ householdId });

  const links = await TransactionOrderLink.findAll({ where: { transactionId: txn.id } });
  assert.equal(links.length, 1, 'the conflicting pair must collapse into one link');
  assert.equal(links[0].externalOrderId, report.id);
  assert.equal(links[0].status, 'accepted', 'the accepted link must win over the merely-suggested one');
  assert.equal(Number(links[0].confidence), 100);
});
