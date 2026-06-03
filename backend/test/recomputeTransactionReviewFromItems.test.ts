// backend/test/recomputeTransactionReviewFromItems.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import {
  sequelize,
  Account,
  Transaction,
  TransactionSignal,
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
  User,
  Household,
  HouseholdMember,
  Session,
} from '../src/models';
import { recomputeTransactionReviewFromItems } from '../src/import/enrichment/recomputeTransactionReviewFromItems';
import { hashPassword, hashToken } from '../src/auth/password';

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

// ---------------------------------------------------------------------------
// Route-level tests: PATCH /api/external-order-items/:id
//                    POST /api/external-order-items/bulk-patch
// Verify that the handlers trigger review recompute after persisting overrides.
// ---------------------------------------------------------------------------

test('route: PATCH /api/external-order-items/:id triggers review recompute', async () => {
  // Import app lazily so SQLite DB is already initialised by the outer before().
  const { default: app } = await import('../src/app.js');

  // Seed auth rows.
  const password = await hashPassword('password123');
  const routeUser = await User.create({
    email: `route-patch-${Date.now()}@example.com`,
    displayName: 'Route Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);
  const routeHousehold = await Household.create({ name: 'Route Patch HH' } as never);
  await HouseholdMember.create({
    householdId: routeHousehold.id,
    userId: routeUser.id,
    role: 'owner',
  } as never);
  const token = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId: routeUser.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  const routeAccount = await Account.create({
    householdId: routeHousehold.id,
    name: 'Route Card',
    visibility: 'private',
  } as never);

  // Build a transaction with a straggler item (no category resolved yet).
  const fp = `route-patch-${Date.now()}`;
  const txn = await Transaction.create({
    accountId: routeAccount.id,
    householdId: routeHousehold.id,
    createdByUserId: routeUser.id,
    visibility: 'shared',
    importBatch: 'test',
    date: '2026-05-01',
    amount: '-50.00',
    currency: 'CAD',
    merchantRaw: 'COSTCO',
    merchantClean: 'Costco',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: true,
    finalSplitType: 'me',
  } as never);

  await TransactionSignal.create({
    transactionId: txn.id,
    source: 'item-link',
    confidence: 'medium',
    fields: { autoCategory: 'Mixed' },
  } as never);

  const order = await ExternalOrder.create({
    householdId: routeHousehold.id,
    vendor: 'costco',
    dedupeKey: `route-patch-${Date.now()}-${Math.random()}`,
    total: '50.00',
    currency: 'CAD',
    orderDate: '2026-05-01',
    source: 'test',
  } as never);

  // The one straggler item — starts uncategorised, will be overridden via PATCH.
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Mystery Item',
    inferredCategory: null,
    categoryOverride: null,
    confidence: null,
  } as never);

  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90',
    matchReason: 'test',
    status: 'accepted',
  } as never);

  // Confirm the txn starts in review.
  assert.equal((await Transaction.findByPk(txn.id))!.reviewFlag, true);

  // PATCH the item with a category override via the HTTP route.
  const agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
  const res = await agent
    .patch(`/api/external-order-items/${item.id}`)
    .send({ categoryOverride: 'Household' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  // The route should have triggered recompute — reviewFlag must now be false.
  const after = await Transaction.findByPk(txn.id);
  assert.equal(
    after!.reviewFlag,
    false,
    'reviewFlag should be cleared after PATCH sets a category override',
  );
});

test('categorization completing high-confidence clears an already-linked txn', async () => {
  // Create a txn with an accepted order link and one straggler item (no category),
  // plus an item-link signal at medium confidence (which sets reviewFlag=true).
  const id = await makeItemizedTxn({
    reviewFlag: true,
    signals: [{ source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } }],
    items: [
      { inferredCategory: null, categoryOverride: null, confidence: null }, // straggler
    ],
  });

  // Confirm the txn starts in review.
  const before = await Transaction.findByPk(id);
  assert.equal(before!.reviewFlag, true);

  // Simulate categorization completing: update the straggler to high-confidence Groceries.
  await ExternalOrderItem.update(
    { inferredCategory: 'Groceries', confidence: '90' },
    { where: { inferredCategory: null } },
  );

  // Recompute: the function should see all items resolved and clear the flag.
  await recomputeTransactionReviewFromItems(id);

  const after = await Transaction.findByPk(id);
  assert.equal(
    after!.reviewFlag,
    false,
    'reviewFlag should be cleared once all items are high-confidence',
  );
});

// ---------------------------------------------------------------------------
// categorizeAndApplyReceiptItems — household-wide path (no explicit orderId)
// Regression: when called with { householdId, limit } and no orderId/orderIds,
// the recompute used to skip entirely because orderIdList was [].
// ---------------------------------------------------------------------------

test('categorizeAndApply with no orderId derives touched orders and clears reviewFlag', async () => {
  const { categorizeAndApplyReceiptItems } = await import('../src/import/categorizeReceiptItems.js');

  // Build a txn with one straggler item (inferredCategory=null).
  const id = await makeItemizedTxn({
    reviewFlag: true,
    signals: [{ source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } }],
    items: [
      { inferredCategory: null, categoryOverride: null, confidence: null }, // straggler
    ],
  });

  // Confirm the txn starts in review.
  assert.equal((await Transaction.findByPk(id))!.reviewFlag, true);

  // Find the item we just created so we can target it with the fake AI caller.
  const links = await TransactionOrderLink.findAll({ where: { transactionId: id } });
  const orderId = links[0].externalOrderId;
  const stragglerItems = await ExternalOrderItem.findAll({ where: { externalOrderId: orderId } });
  const stragglerItemId = stragglerItems[0].id;

  // Fake AI caller that returns a single high-confidence categorization for the straggler item.
  const fakeOpenaiCaller = async () => ({
    json: {
      items: [
        { itemId: stragglerItemId, category: 'Groceries', confidence: 95, rationale: 'test' },
      ],
    },
    model: 'gpt-4o-mini',
    temperature: 0.1,
    latencyMs: 1,
    providerRequestId: 'fake-req-id',
    rawTextPreview: '{}',
  });

  // Call with NO orderId — the household-wide path.
  const updated = await categorizeAndApplyReceiptItems(
    { householdId: HH, limit: 200 },
    { openaiCaller: fakeOpenaiCaller },
  );

  assert.ok(updated >= 1, `expected at least 1 update, got ${updated}`);

  // The fix: review flag must now be cleared because the derive-from-items path ran.
  const after = await Transaction.findByPk(id);
  assert.equal(
    after!.reviewFlag,
    false,
    'reviewFlag must be cleared when categorizeAndApplyReceiptItems runs without an explicit orderId',
  );
});

test('backfill clears pre-existing fully-categorized itemized txns and is idempotent', async () => {
  const { backfillItemReviewClears } = await import('../src/import/enrichmentBackfillScheduler.js');

  const id = await makeItemizedTxn({
    reviewFlag: true,
    signals: [{ source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } }],
    items: [{ inferredCategory: 'Groceries', categoryOverride: null, confidence: 90 }],
  });
  const first = await backfillItemReviewClears();
  assert.ok(first.recomputed >= 1);
  assert.equal((await Transaction.findByPk(id))!.reviewFlag, false);

  const second = await backfillItemReviewClears(); // idempotent
  assert.equal((await Transaction.findByPk(id))!.reviewFlag, false);
  assert.ok(second.recomputed >= 0);
});

test('route: POST /api/external-order-items/bulk-patch triggers review recompute', async () => {
  const { default: app } = await import('../src/app.js');

  // Seed auth rows.
  const password = await hashPassword('password123');
  const bulkUser = await User.create({
    email: `route-bulk-${Date.now()}@example.com`,
    displayName: 'Bulk Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);
  const bulkHousehold = await Household.create({ name: 'Route Bulk HH' } as never);
  await HouseholdMember.create({
    householdId: bulkHousehold.id,
    userId: bulkUser.id,
    role: 'owner',
  } as never);
  const bulkToken = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId: bulkUser.id,
    tokenHash: hashToken(bulkToken),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  const bulkAccount = await Account.create({
    householdId: bulkHousehold.id,
    name: 'Bulk Card',
    visibility: 'private',
  } as never);

  // Two transactions, each with an uncategorised straggler item.
  async function makeBulkTxn(label: string): Promise<{ txnId: number; itemId: number }> {
    const fp = `route-bulk-${label}-${Date.now()}`;
    const txn = await Transaction.create({
      accountId: bulkAccount.id,
      householdId: bulkHousehold.id,
      createdByUserId: bulkUser.id,
      visibility: 'shared',
      importBatch: 'test',
      date: '2026-05-02',
      amount: '-25.00',
      currency: 'CAD',
      merchantRaw: 'COSTCO',
      merchantClean: 'Costco',
      sourceRowFingerprint: fp,
      sourceIdentityFingerprint: fp,
      txnType: 'purchase',
      reviewFlag: true,
      finalSplitType: 'me',
    } as never);
    await TransactionSignal.create({
      transactionId: txn.id,
      source: 'item-link',
      confidence: 'medium',
      fields: { autoCategory: 'Mixed' },
    } as never);
    const order = await ExternalOrder.create({
      householdId: bulkHousehold.id,
      vendor: 'costco',
      dedupeKey: `bulk-${label}-${Date.now()}-${Math.random()}`,
      total: '25.00',
      currency: 'CAD',
      orderDate: '2026-05-02',
      source: 'test',
    } as never);
    const item = await ExternalOrderItem.create({
      externalOrderId: order.id,
      title: `Bulk Item ${label}`,
      inferredCategory: null,
      categoryOverride: null,
      confidence: null,
    } as never);
    await TransactionOrderLink.create({
      transactionId: txn.id,
      externalOrderId: order.id,
      confidence: '90',
      matchReason: 'test',
      status: 'accepted',
    } as never);
    return { txnId: txn.id, itemId: item.id };
  }

  const a = await makeBulkTxn('a');
  const b = await makeBulkTxn('b');

  assert.equal((await Transaction.findByPk(a.txnId))!.reviewFlag, true);
  assert.equal((await Transaction.findByPk(b.txnId))!.reviewFlag, true);

  const agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${bulkToken}; Path=/`);
  const res = await agent
    .post('/api/external-order-items/bulk-patch')
    .send({ itemIds: [a.itemId, b.itemId], categoryOverride: 'Groceries' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.updated, 2);

  const afterA = await Transaction.findByPk(a.txnId);
  const afterB = await Transaction.findByPk(b.txnId);
  assert.equal(afterA!.reviewFlag, false, 'txn A reviewFlag should be cleared');
  assert.equal(afterB!.reviewFlag, false, 'txn B reviewFlag should be cleared');
});
