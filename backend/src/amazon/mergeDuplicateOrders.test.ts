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
  Receipt,
  ExternalOrderTender,
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

test('a link conflict on the same transaction also carries linkedAmount from the winning link', async () => {
  const householdId = 8;
  const { report, email } = await seedPair(householdId);
  const { txn } = await seedHouseholdWithTxn(householdId);

  // A weak suggestion already exists against the survivor, with no linkedAmount...
  await TransactionOrderLink.create({
    transactionId: txn.id, externalOrderId: report.id,
    confidence: '50', matchReason: 'weak guess', status: 'suggested',
  } as never);
  // ...but the user accepted a split/partial-payment match against the loser,
  // which carries a real linkedAmount set by matchReceiptToTransactions.
  await TransactionOrderLink.create({
    transactionId: txn.id, externalOrderId: email.id,
    confidence: '100', matchReason: 'manually linked by user', status: 'accepted',
    linkedAmount: '15.50',
  } as never);

  await mergeDuplicateAmazonOrders({ householdId });

  const links = await TransactionOrderLink.findAll({ where: { transactionId: txn.id } });
  assert.equal(links.length, 1, 'the conflicting pair must collapse into one link');
  assert.equal(links[0].externalOrderId, report.id);
  assert.equal(links[0].status, 'accepted');
  assert.equal(
    Number(links[0].linkedAmount),
    15.5,
    'the winning link\'s linkedAmount must be copied onto the survivor\'s link, not dropped',
  );
});

// ─── shipmentDate coalescing ─────────────────────────────────────────────────

test('shipmentDate from a losing CSV-sourced row is coalesced onto the survivor', async () => {
  const householdId = 9;
  const vendorOrderId = '701-6488283-5477862';
  // The email row is created first (lower id, so it survives) and, like every
  // email-sourced row, has no shipmentDate. The CSV/report row is created
  // second (the loser) and carries the shipmentDate populated by the CSV
  // import path.
  const email = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `e-${householdId}`, orderDate: null, total: '38.26', currency: 'CAD',
    paymentLast4: null, source: 'gmail-scan:ai', shipmentDate: null,
  } as never);
  const report = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `r-${householdId}`, orderDate: '2025-08-27', total: '10.11', currency: 'CAD',
    paymentLast4: '1001', source: 'amazon_report', shipmentDate: '2025-08-29',
  } as never);

  const out = await mergeDuplicateAmazonOrders({ householdId });
  assert.equal(out.merged, 1);

  const survivor = await ExternalOrder.findOne({ where: { householdId, vendorOrderId } });
  assert.equal(survivor?.id, email.id, 'the older (email) row survives');
  assert.equal(
    survivor?.shipmentDate,
    '2025-08-29',
    'shipmentDate from the losing CSV row must be coalesced onto the survivor',
  );
  void report;
});

// ─── Receipt / ExternalOrderTender re-parenting ──────────────────────────────

test('a Receipt and an ExternalOrderTender on the losing order are re-parented to the survivor', async () => {
  const householdId = 10;
  const { report, email } = await seedPair(householdId);
  const { txn } = await seedHouseholdWithTxn(householdId);

  const receipt = await Receipt.create({
    transactionId: txn.id,
    storedFilename: 'stored.png',
    originalName: 'receipt.png',
    mimeType: 'image/png',
    sizeBytes: 1234,
    externalOrderId: email.id,
  } as never);
  const tender = await ExternalOrderTender.create({
    externalOrderId: email.id,
    amount: '38.26',
  } as never);

  await mergeDuplicateAmazonOrders({ householdId });

  await receipt.reload();
  await tender.reload();
  assert.equal(receipt.externalOrderId, report.id, 'the Receipt must be re-pointed at the survivor');
  assert.equal(tender.externalOrderId, report.id, 'the ExternalOrderTender must be re-pointed at the survivor');
});

// ─── FIX 4: rawPayload.gmailMessageId survives the merge ────────────────────
//
// ProcessedEmailMessage.external_order_id is ON DELETE SET NULL, so once the
// email-sourced (loser) row is destroyed, the only remaining path back to
// the Gmail message is rawPayload.gmailMessageId -- but only if it now lives
// on the SURVIVOR. Without this, forceReprocess (scanReceipts.ts's
// findExistingOrderForMessage) can never find the order again.

test('rawPayload.gmailMessageId is coalesced onto the survivor before the loser is destroyed', async () => {
  const householdId = 11;
  const vendorOrderId = '701-1111111-2222222';
  const report = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `r-${householdId}`, orderDate: '2025-08-27', total: '10.11', currency: 'CAD',
    source: 'amazon_report', rawPayload: null,
  } as never);
  const email = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `e-${householdId}`, orderDate: null, total: '38.26', currency: 'CAD',
    source: 'gmail-scan:ai', rawPayload: { gmailMessageId: 'msg-xyz', parser: 'ai' },
  } as never);

  await mergeDuplicateAmazonOrders({ householdId });

  const survivor = await ExternalOrder.findOne({ where: { householdId, vendorOrderId } });
  assert.equal(survivor?.id, report.id, 'the older (report) row survives');
  const rawPayload = survivor?.rawPayload as { gmailMessageId?: string } | null;
  assert.equal(
    rawPayload?.gmailMessageId,
    'msg-xyz',
    'the loser\'s Gmail message id must survive on the survivor so a reprocess can still find this order',
  );
  void email;
});

test('the survivor keeps its own rawPayload.gmailMessageId when it already has one', async () => {
  const householdId = 12;
  const vendorOrderId = '701-3333333-4444444';
  const email1 = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `e1-${householdId}`, orderDate: '2025-08-27', total: '10.11', currency: 'CAD',
    source: 'gmail-scan:ai', rawPayload: { gmailMessageId: 'msg-survivor-own' },
  } as never);
  await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `e2-${householdId}`, orderDate: null, total: '38.26', currency: 'CAD',
    source: 'gmail-scan:ai', rawPayload: { gmailMessageId: 'msg-loser' },
  } as never);

  await mergeDuplicateAmazonOrders({ householdId });

  const survivor = await ExternalOrder.findOne({ where: { householdId, vendorOrderId } });
  assert.equal(survivor?.id, email1.id);
  const rawPayload = survivor?.rawPayload as { gmailMessageId?: string } | null;
  assert.equal(rawPayload?.gmailMessageId, 'msg-survivor-own', 'the survivor\'s own gmailMessageId is never overwritten');
});

// ─── FIX 5: colliding item overrides survive the merge ──────────────────────
//
// An item dedupe collision (title|totalPrice|quantity) destroys the loser
// item outright. categoryOverride/categoryOverrideId/businessUseOverride/
// businessUsePercent are hand-entered values the survivor's twin may lack --
// losing them to a nightly cron is real data loss.

test('a colliding item copies missing override fields from the loser before being destroyed', async () => {
  const householdId = 13;
  const vendorOrderId = '701-5555555-6666666';
  await Household.create({ id: householdId, name: `HH-${householdId}` } as never);
  const report = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `r-${householdId}`, orderDate: '2025-08-27', total: '10.11', currency: 'CAD',
    source: 'amazon_report',
  } as never);
  const email = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `e-${householdId}`, orderDate: null, total: '10.11', currency: 'CAD',
    source: 'gmail-scan:ai',
  } as never);
  const survivorItem = await ExternalOrderItem.create({
    externalOrderId: report.id, title: 'Widget', quantity: 1,
    unitPrice: '10.11', totalPrice: '10.11',
  } as never);
  const loserItem = await ExternalOrderItem.create({
    externalOrderId: email.id, title: 'Widget', quantity: 1,
    unitPrice: '10.11', totalPrice: '10.11',
    categoryOverride: 'Business Supplies',
    businessUseOverride: '100',
    businessUsePercent: '80',
  } as never);

  await mergeDuplicateAmazonOrders({ householdId });

  await survivorItem.reload();
  assert.equal(survivorItem.categoryOverride, 'Business Supplies', 'categoryOverride is copied from the loser');
  assert.equal(Number(survivorItem.businessUseOverride), 100, 'businessUseOverride is copied from the loser');
  assert.equal(Number(survivorItem.businessUsePercent), 80, 'businessUsePercent is copied from the loser');

  const stillThere = await ExternalOrderItem.findByPk(loserItem.id);
  assert.equal(stillThere, null, 'the colliding loser item is still destroyed, not kept as a duplicate');
});

test('a colliding item never overwrites an override the survivor twin already has', async () => {
  const householdId = 14;
  const vendorOrderId = '701-7777777-8888888';
  await Household.create({ id: householdId, name: `HH-${householdId}` } as never);
  const report = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `r-${householdId}`, orderDate: '2025-08-27', total: '10.11', currency: 'CAD',
    source: 'amazon_report',
  } as never);
  const email = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId,
    dedupeKey: `e-${householdId}`, orderDate: null, total: '10.11', currency: 'CAD',
    source: 'gmail-scan:ai',
  } as never);
  const survivorItem = await ExternalOrderItem.create({
    externalOrderId: report.id, title: 'Widget', quantity: 1,
    unitPrice: '10.11', totalPrice: '10.11',
    categoryOverride: 'Groceries',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: email.id, title: 'Widget', quantity: 1,
    unitPrice: '10.11', totalPrice: '10.11',
    categoryOverride: 'Business Supplies',
  } as never);

  await mergeDuplicateAmazonOrders({ householdId });

  await survivorItem.reload();
  assert.equal(survivorItem.categoryOverride, 'Groceries', 'the survivor twin\'s own override is never clobbered by the loser\'s');
});

// ─── FIX 7: per-group isolation ──────────────────────────────────────────────
//
// mergeDuplicateAmazonOrders is the first statement of runAmazonMatching, so
// one group throwing used to reject the whole function and block matching
// entirely -- every night, silently, once the cron (gmailReceiptScan.ts)
// started calling it unattended. Each group must be isolated: a failure logs
// and the loop continues, and each group's own transaction stays atomic.

test('one group throwing during the merge does not block other groups from merging', async () => {
  const householdId = 15;
  const { report: badReport } = await seedPair(householdId, 'BAD-VENDOR-ORDER-1');
  const { report: goodReport } = await seedPair(householdId, 'GOOD-VENDOR-ORDER-1');

  const originalFindAll = ExternalOrderItem.findAll.bind(ExternalOrderItem);
  (ExternalOrderItem as unknown as { findAll: typeof ExternalOrderItem.findAll }).findAll = (async (
    options?: { where?: { externalOrderId?: unknown } },
  ) => {
    if (options?.where?.externalOrderId === badReport.id) {
      throw new Error('simulated failure merging BAD-VENDOR-ORDER-1');
    }
    return originalFindAll(options as never);
  }) as typeof ExternalOrderItem.findAll;

  try {
    const out = await mergeDuplicateAmazonOrders({ householdId });
    assert.equal(out.merged, 1, 'the good group merges despite the bad group throwing');
  } finally {
    ExternalOrderItem.findAll = originalFindAll;
  }

  const goodSurvivors = await ExternalOrder.count({ where: { householdId, vendorOrderId: 'GOOD-VENDOR-ORDER-1' } });
  assert.equal(goodSurvivors, 1, 'the good group merged down to one row');

  const badSurvivors = await ExternalOrder.count({ where: { householdId, vendorOrderId: 'BAD-VENDOR-ORDER-1' } });
  assert.equal(badSurvivors, 2, 'the bad group is left untouched (its own transaction rolled back), not half-merged');
  void goodReport;
});
