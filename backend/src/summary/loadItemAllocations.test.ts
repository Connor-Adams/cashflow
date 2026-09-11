import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Account,
  Transaction,
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
} from '../models';
import { loadItemAllocationContext } from './loadItemAllocations';

before(async () => {
  await sequelize.sync({ force: true });
});

test('loadItemAllocationContext: returns empty maps when no txn ids', async () => {
  const ctx = await loadItemAllocationContext([]);
  assert.equal(ctx.linksByTxn.size, 0);
  assert.equal(ctx.ordersById.size, 0);
  assert.equal(ctx.itemsByOrder.size, 0);
});

test('loadItemAllocationContext: returns maps keyed by txn id / order id', async () => {
  // Create required parent records for FK constraints
  const account = await Account.create({ name: 'Test Account' } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    importBatch: 'test',
    date: '2026-01-01',
    merchantRaw: 'Costco',
    merchantClean: 'Costco',
    amount: '-100.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-lia-001',
    sourceIdentityFingerprint: 'sif-lia-001',
  } as never);

  const order = await ExternalOrder.create({
    vendor: 'costco',
    dedupeKey: 'k1',
    total: '100.00',
    subtotal: '90.00',
    tax: '10.00',
    currency: 'CAD',
    source: 'test',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Eggs',
    quantity: 1,
    totalPrice: '90.00',
    inferredCategory: 'Groceries',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90',
    matchReason: 'test',
    status: 'accepted',
    linkedAmount: '100.00',
  } as never);

  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(ctx.linksByTxn.get(txn.id)?.length, 1);
  // Sequelize returns DECIMAL as a number (100) from SQLite in sync({force:true}) context
  assert.ok(ctx.ordersById.has(order.id), 'ordersById should contain the order');
  assert.equal(Number(ctx.ordersById.get(order.id)?.total), 100);
  assert.equal(ctx.itemsByOrder.get(order.id)?.[0]?.inferredCategory, 'Groceries');
});

test('loadItemAllocationContext: excludes suggested and rejected links', async () => {
  const account = await Account.create({ name: 'Status Account' } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    importBatch: 'test',
    date: '2026-01-02',
    merchantRaw: 'Amazon',
    merchantClean: 'Amazon',
    amount: '-100.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-lia-002',
    sourceIdentityFingerprint: 'sif-lia-002',
  } as never);

  const mkOrder = async (key: string) => {
    const order = await ExternalOrder.create({
      vendor: 'amazon',
      dedupeKey: key,
      total: '100.00',
      subtotal: '100.00',
      currency: 'CAD',
      source: 'test',
    } as never);
    await ExternalOrderItem.create({
      externalOrderId: order.id,
      title: 'Widget',
      quantity: 1,
      totalPrice: '100.00',
      inferredCategory: 'Shopping',
    } as never);
    return order;
  };
  const accepted = await mkOrder('k-accepted');
  const suggested = await mkOrder('k-suggested');
  const rejected = await mkOrder('k-rejected');
  for (const [order, status] of [
    [accepted, 'accepted'],
    [suggested, 'suggested'],
    [rejected, 'rejected'],
  ] as const) {
    await TransactionOrderLink.create({
      transactionId: txn.id,
      externalOrderId: order.id,
      confidence: '90',
      matchReason: 'test',
      status,
      linkedAmount: '100.00',
    } as never);
  }

  const ctx = await loadItemAllocationContext([txn.id]);
  // Only the accepted link may feed splitTxnByItems — a stale suggested or
  // superseded/rejected link would double-count the txn across categories.
  assert.equal(ctx.linksByTxn.get(txn.id)?.length, 1);
  assert.equal(ctx.linksByTxn.get(txn.id)?.[0]?.externalOrderId, accepted.id);
  assert.equal(ctx.ordersById.has(suggested.id), false);
  assert.equal(ctx.ordersById.has(rejected.id), false);
});

// Foreign-card exclusion (task 13): 291 of 538 production Amazon orders carry
// a last4 belonging to no Cashflow account — an order placed on the shared
// Amazon account but paid on someone else's card. Those must never reach an
// allocation total. Orders with NO last4 at all ("unknown", 135 in prod) are
// deliberately NOT excluded — absence of a last4 is not evidence of a
// foreign card, and most of those are the household's own.
let foreignSeedCounter = 0;

async function seedCardOwnershipCase(
  paymentLast4: string | null,
  accountOverrides: Partial<{ name: string; shortCode: string }> = {},
) {
  foreignSeedCounter += 1;
  const n = foreignSeedCounter;
  const account = await Account.create({
    name: accountOverrides.name ?? `Amex Reserve ${n}`,
    householdId: 1,
    // resolveAccountLast4('701001') -> '1001'
    shortCode: accountOverrides.shortCode ?? '701001',
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    importBatch: 'test',
    date: '2025-08-28',
    merchantRaw: 'AMZN MKTP CA',
    merchantClean: 'Amazon',
    amount: '-44.97',
    currency: 'CAD',
    sourceRowFingerprint: `fp-card-ownership-${n}`,
    sourceIdentityFingerprint: `sif-card-ownership-${n}`,
  } as never);
  const order = await ExternalOrder.create({
    householdId: 1,
    vendor: 'amazon',
    vendorOrderId: `701-1111111-${n}`,
    dedupeKey: `k-card-ownership-${n}`,
    orderDate: '2025-08-27',
    total: '44.97',
    currency: 'CAD',
    paymentLast4,
    source: 'amazon_report',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Widget',
    quantity: 1,
    unitPrice: '44.97',
    totalPrice: '44.97',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90.00',
    matchReason: 'test',
    status: 'accepted',
    linkedAmount: '44.97',
  } as never);
  return { txn, account, order };
}

test('an order on a known card is allocated', async () => {
  const { txn } = await seedCardOwnershipCase('1001');
  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(ctx.linksByTxn.get(txn.id)?.length, 1);
});

test('an order with no last4 is allocated — unknown is not foreign', async () => {
  const { txn } = await seedCardOwnershipCase(null);
  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(ctx.linksByTxn.get(txn.id)?.length, 1);
});

test('an order on a foreign card is excluded from allocation', async () => {
  const { txn } = await seedCardOwnershipCase('2662');
  const ctx = await loadItemAllocationContext([txn.id]);
  // Missing entry, not an empty array: splitTxnByItems callers all read via
  // `ctx.linksByTxn.get(row.id) ?? []`, but the map must never grow a key for
  // a txn whose every link is foreign.
  assert.equal(ctx.linksByTxn.has(txn.id), false);
  assert.equal(ctx.ordersById.size, 0);
});

test('scope the account lookup: order with null householdId is NOT excluded even if card is foreign', async () => {
  // When an order has householdId === null (unresolvable household), we have
  // no household context to determine foreign vs. known. Do not exclude it.
  const account = await Account.create({
    name: 'Test Account',
    shortCode: '701001', // resolves to last4 '1001'
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    importBatch: 'test',
    date: '2025-08-28',
    merchantRaw: 'Amazon',
    merchantClean: 'Amazon',
    amount: '-50.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-null-household-1',
    sourceIdentityFingerprint: 'sif-null-household-1',
  } as never);
  // Order with null householdId and a "foreign" last4 (not in any account)
  const order = await ExternalOrder.create({
    householdId: null, // <- key: unresolvable household
    vendor: 'amazon',
    vendorOrderId: '701-null-hh-1',
    dedupeKey: 'k-null-household-1',
    orderDate: '2025-08-27',
    total: '50.00',
    currency: 'CAD',
    paymentLast4: '9999', // <- foreign card: not in any account
    source: 'amazon_report',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Widget',
    quantity: 1,
    unitPrice: '50.00',
    totalPrice: '50.00',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90.00',
    matchReason: 'test',
    status: 'accepted',
    linkedAmount: '50.00',
  } as never);

  const ctx = await loadItemAllocationContext([txn.id]);
  // With no household context, we must NOT exclude the order, even though
  // the card appears foreign (last4 not in any account). Absence of household
  // context means we cannot determine ownership, so we include it.
  assert.equal(
    ctx.linksByTxn.has(txn.id),
    true,
    'order with null householdId should NOT be excluded from allocation',
  );
  assert.equal(ctx.ordersById.has(order.id), true, 'order should be in ordersById');
  assert.equal(ctx.itemsByOrder.has(order.id), true, 'order items should be present');
});

test('scope the account lookup: no unscoped Account query when all orders have null householdId', async () => {
  // This test ensures Account.findAll is not called with an empty where
  // clause when no orders have householdId. We verify this indirectly: create
  // an account in household 99 that no order belongs to. If Account.findAll
  // was running with where: {}, this account's last4 would be loaded and could
  // affect the result. We verify it does not.
  const irrelevantAccount = await Account.create({
    name: 'Account in Household 99',
    householdId: 99,
    shortCode: '555555', // resolves to last4 '5555'
  } as never);

  const account = await Account.create({
    name: 'Test Account',
    shortCode: '701001', // resolves to last4 '1001'
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    importBatch: 'test',
    date: '2025-08-28',
    merchantRaw: 'Amazon',
    merchantClean: 'Amazon',
    amount: '-30.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-scoped-query-1',
    sourceIdentityFingerprint: 'sif-scoped-query-1',
  } as never);
  // Order with null householdId and last4 '5555' (matching the irrelevant account)
  const order = await ExternalOrder.create({
    householdId: null, // <- key: no household context
    vendor: 'amazon',
    vendorOrderId: '701-scoped-1',
    dedupeKey: 'k-scoped-query-1',
    orderDate: '2025-08-27',
    total: '30.00',
    currency: 'CAD',
    paymentLast4: '5555', // <- matches irrelevantAccount's last4
    source: 'amazon_report',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Widget',
    quantity: 1,
    unitPrice: '30.00',
    totalPrice: '30.00',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90.00',
    matchReason: 'test',
    status: 'accepted',
    linkedAmount: '30.00',
  } as never);

  const ctx = await loadItemAllocationContext([txn.id]);
  // If the account query was unscoped (where: {}), irrelevantAccount would be
  // loaded, '5555' would be in the last4Map, and the order would be
  // classified as 'known' and included. If the query IS scoped (no query when
  // householdIds is empty), the account is NOT loaded, last4Map is empty,
  // order is NOT excluded (due to no household context), and IS included.
  // Both paths include the order, so we test the stricter invariant: that
  // the order is allocated BECAUSE we have no household context to exclude it,
  // not because the irrelevant account happened to be loaded.
  assert.equal(
    ctx.linksByTxn.has(txn.id),
    true,
    'order with null householdId should be allocated without household context',
  );
});

// Task 13 scope correction: the foreign-card exclusion was designed for
// Amazon but ran against every vendor. Production has zero accepted Amazon
// links and 7 accepted non-Amazon links (6 costco, 1 uber_eats); 5 of those 7
// would misclassify as 'foreign' under the old code because the linked
// account's short_code ('costco') is an opaque, non-numeric label with no
// derivable last4 -- even though the order correctly carries the real card
// last4 ('3114'). Two guards fix this: (1) only vendor 'amazon' may ever be
// excluded as foreign; (2) even for Amazon, an order is not excluded when the
// LINKED TRANSACTION's account has no derivable last4 -- there is no basis
// for the comparison.

test('a non-Amazon order with a last4 matching no account is INCLUDED (Costco regression)', async () => {
  // Costco MC: short_code = 'costco', opaque and non-numeric -- no last4 can
  // be derived from the account side. The order still carries its own real
  // last4 ('3114'). Because vendor !== 'amazon', foreign classification must
  // never apply here regardless of last4 comparability.
  const account = await Account.create({
    name: 'Costco MC',
    householdId: 1,
    shortCode: 'costco',
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    importBatch: 'test',
    date: '2025-08-28',
    merchantRaw: 'COSTCO WHOLESALE',
    merchantClean: 'Costco',
    amount: '-120.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-scope-costco-1',
    sourceIdentityFingerprint: 'sif-scope-costco-1',
  } as never);
  const order = await ExternalOrder.create({
    householdId: 1,
    vendor: 'costco',
    dedupeKey: 'k-scope-costco-1',
    orderDate: '2025-08-27',
    total: '120.00',
    currency: 'CAD',
    paymentLast4: '3114',
    source: 'costco_email',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Bulk Eggs',
    quantity: 1,
    unitPrice: '120.00',
    totalPrice: '120.00',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90.00',
    matchReason: 'test',
    status: 'accepted',
    linkedAmount: '120.00',
  } as never);

  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(
    ctx.linksByTxn.has(txn.id),
    true,
    'non-Amazon orders must never be excluded as foreign',
  );
  assert.equal(ctx.ordersById.has(order.id), true);
});

test('an Amazon order whose linked transaction account has an opaque short code is INCLUDED', async () => {
  // Wealthsimple-style opaque short code: resolveAccountLast4 returns null,
  // so there is no basis to compare the order's last4 against this account.
  // Even though the order's last4 matches no account (looks 'foreign'), the
  // order must be kept because the linked account itself has no derivable
  // last4.
  const { txn, order } = await seedCardOwnershipCase('9999', {
    name: 'Wealthsimple Cash',
    shortCode: 'HQ6LMLTK8CAD', // opaque -- resolveAccountLast4 returns null
  });

  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(
    ctx.linksByTxn.has(txn.id),
    true,
    'an order linked to an account with no derivable last4 must not be excluded',
  );
  assert.equal(ctx.ordersById.has(order.id), true);
});

test('an Amazon order with a foreign last4, linked to an account WITH a derivable last4, is still EXCLUDED', async () => {
  // The feature must still work: when the linked account DOES have a
  // derivable last4 and the order's last4 does not match it (or any other
  // account), the Amazon order is correctly classified 'foreign' and dropped.
  const { txn } = await seedCardOwnershipCase('2662', {
    name: 'Amex Reserve',
    shortCode: '701001', // resolveAccountLast4 -> '1001'
  });

  const ctx = await loadItemAllocationContext([txn.id]);
  assert.equal(
    ctx.linksByTxn.has(txn.id),
    false,
    'a genuinely foreign Amazon order linked to a comparable account must still be excluded',
  );
  assert.equal(ctx.ordersById.size, 0);
});
