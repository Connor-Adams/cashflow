/**
 * DB-backed tests proving GET /api/items, /api/items/analyze, and
 * /api/items/analyze/trend hide items from a foreign-card Amazon order while
 * always showing everything else.
 *
 * The Items page queries ExternalOrder/ExternalOrderItem directly and is NOT
 * covered by loadItemAllocationContext's chokepoint (see
 * backend/src/summary/loadItemAllocations.ts and cardOwnership.ts), so it
 * needs its own copy of the exclusion. Mirrors loadItemAllocations.ts'
 * semantics (commit 8b56596a) rather than a vendor-agnostic rule:
 *
 *   1. Only vendor 'amazon' may ever be classified foreign. Production has
 *      zero accepted Amazon links but 7 accepted non-Amazon links (6 costco,
 *      1 uber_eats); a vendor-agnostic rule would have dropped 5 of those 7
 *      ($2,087.08) because Costco's short_code ('costco') is opaque and
 *      derives no last4, even though the order's own last4 ('3114') is real.
 *      The "non-Amazon order, unmatched last4, still shown" test below is
 *      that regression, reproduced directly on the Items page.
 *   2. `unknown` (order has no last4 at all) is shown, never hidden.
 *   3. Even for a candidate Amazon order, an accepted transaction_order_link
 *      whose account has no derivable last4 (opaque short code) gives no
 *      basis for comparison, so the order is kept.
 *
 * Mounts the items router behind a stubbed req.auth (matching the pattern in
 * ./reviewItems.test.ts) on the per-process SQLite test DB.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {
  createFingerprinter,
  makeCardOwnershipAccount,
  makeAmazonOrder,
  makeAmazonTransaction,
} from './cardOwnershipTestHelpers';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const itemsRouter = (await import('./items')).default;
  app = express();
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: 1, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use('/api', itemsRouter);
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.ExternalOrderItem.destroy({ where: {}, truncate: true });
  await models.TransactionOrderLink.destroy({ where: {}, truncate: true });
  await models.ExternalOrder.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  household = await models.Household.create({ name: 'Items Test HH' });
});

const fp = createFingerprinter('items');

async function makeAccount(shortCode: string | null) {
  return makeCardOwnershipAccount(models, household.id, shortCode);
}

async function makeOrder(vendor: string, paymentLast4: string | null, dedupeKey: string) {
  return makeAmazonOrder(models, household.id, vendor, paymentLast4, dedupeKey);
}

async function makeItem(orderId: number, title: string) {
  return models.ExternalOrderItem.create({
    externalOrderId: orderId,
    title,
    quantity: 1,
    unitPrice: '50.00',
    totalPrice: '50.00',
  } as never);
}

/**
 * One order on a known card (1001), one on a genuinely foreign Amazon card
 * (2662, matches no account).
 */
async function seedForeignAndKnownOrders() {
  await makeAccount('701001'); // resolveAccountLast4 -> '1001'
  const known = await makeOrder('amazon', '1001', 'k-known-1');
  await makeItem(known.id, 'KnownCardWidget');
  const foreign = await makeOrder('amazon', '2662', 'k-foreign-1');
  await makeItem(foreign.id, 'ForeignCardWidget');
  return { known, foreign };
}

test('GET /api/items omits items from a foreign-card Amazon order', async () => {
  await seedForeignAndKnownOrders();
  const res = await request(app).get('/api/items');
  assert.equal(res.status, 200);
  const titles = res.body.items.map((r: { title: string }) => r.title);
  assert.equal(titles.includes('KnownCardWidget'), true);
  assert.equal(titles.includes('ForeignCardWidget'), false);
});

// Task 15: surface cardOwnership on ItemRow.order so the Items page can
// badge "unverified card" / "not your card" instead of items silently
// disappearing. classifyCardOwnershipForVendor's vendor-only-foreign guard
// (cardOwnership.ts) must hold in the serialized response too.
test('GET /api/items marks a known-card order as cardOwnership "known"', async () => {
  await seedForeignAndKnownOrders();
  const res = await request(app).get('/api/items');
  assert.equal(res.status, 200);
  const row = res.body.items.find((r: { title: string }) => r.title === 'KnownCardWidget');
  assert.equal(row.order.cardOwnership, 'known');
});

test('GET /api/items/analyze omits foreign-card Amazon items', async () => {
  await seedForeignAndKnownOrders();
  const res = await request(app).get('/api/items/analyze');
  assert.equal(res.status, 200);
  const names = res.body.topItems.map((r: { name: string }) => r.name.toLowerCase());
  assert.equal(names.includes('knowncardwidget'), true);
  assert.equal(names.includes('foreigncardwidget'), false);
});

test('GET /api/items/analyze/trend omits points for a foreign-card Amazon item', async () => {
  await seedForeignAndKnownOrders();
  const res = await request(app)
    .get('/api/items/analyze/trend')
    .query({ itemName: 'ForeignCardWidget' });
  assert.equal(res.status, 200);
  assert.equal(res.body.points.length, 0);
});

test('GET /api/items/analyze/trend still returns points for a known-card item', async () => {
  await seedForeignAndKnownOrders();
  const res = await request(app)
    .get('/api/items/analyze/trend')
    .query({ itemName: 'KnownCardWidget' });
  assert.equal(res.status, 200);
  assert.equal(res.body.points.length, 1);
});

test('an unknown-card order (no last4 at all) is shown, not treated as foreign', async () => {
  const order = await makeOrder('amazon', null, 'k-unknown-1');
  await makeItem(order.id, 'NoLast4Widget');
  const res = await request(app).get('/api/items');
  const titles = res.body.items.map((r: { title: string }) => r.title);
  assert.equal(titles.includes('NoLast4Widget'), true);
  const row = res.body.items.find((r: { title: string }) => r.title === 'NoLast4Widget');
  assert.equal(row.order.cardOwnership, 'unknown');
});

test('a non-Amazon order with a last4 matching no account is still SHOWN (Costco regression)', async () => {
  // Costco MC: short_code = 'costco', opaque and non-numeric -- no last4 can
  // be derived from the account side. The order still carries its own real
  // last4 ('3114'), which matches no account and would look "foreign" under
  // a vendor-agnostic rule. Because vendor !== 'amazon', it must never be
  // excluded regardless of last4 comparability -- this is the bug that
  // nearly shipped (5 of 7 accepted production links, $2,087.08).
  await makeAccount('costco');
  const order = await makeOrder('costco', '3114', 'k-costco-regression-1');
  await makeItem(order.id, 'BulkEggsWidget');

  const res = await request(app).get('/api/items');
  assert.equal(res.status, 200);
  const titles = res.body.items.map((r: { title: string }) => r.title);
  assert.equal(titles.includes('BulkEggsWidget'), true);
  const row = res.body.items.find((r: { title: string }) => r.title === 'BulkEggsWidget');
  // Never 'foreign' for a non-Amazon vendor, even though the order's own
  // last4 matches no account.
  assert.equal(row.order.cardOwnership, 'known');
});

test('an Amazon order linked to an account with no derivable last4 is still SHOWN', async () => {
  // Wealthsimple-style opaque short code: resolveAccountLast4 returns null,
  // so there is no basis to compare the order's last4 against this account.
  const account = await makeAccount('HQ6LMLTK8CAD');
  const txn = await makeAmazonTransaction(models, household.id, account.id, fp);
  const order = await makeOrder('amazon', '9999', 'k-opaque-account-1'); // matches no account
  await makeItem(order.id, 'OpaqueAccountWidget');
  await models.TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90.00',
    matchReason: 'test',
    status: 'accepted',
    linkedAmount: '50.00',
  } as never);

  const res = await request(app).get('/api/items');
  assert.equal(res.status, 200);
  const titles = res.body.items.map((r: { title: string }) => r.title);
  assert.equal(titles.includes('OpaqueAccountWidget'), true);
  // The order's own last4 ('9999') matches no account, which would raw-
  // classify as 'foreign' -- but this row was kept precisely because there
  // was no basis for that comparison, so it must not be badged foreign
  // either: an item that counts toward spend must never show "not your
  // card". It is also not 'known': the card genuinely isn't verified, we
  // are only counting this order on benefit of the doubt because the linked
  // account's short code is opaque. 'unknown' (task 15 finding 2) renders
  // the honest "unverified card" badge instead of overclaiming verification.
  const row = res.body.items.find((r: { title: string }) => r.title === 'OpaqueAccountWidget');
  assert.equal(row.order.cardOwnership, 'unknown');
});

// ─── FIX 2: household-level "no basis for comparison" guard ────────────────
//
// foreignOrderIds' guard 3 only "saves" a candidate Amazon order when it has
// an ACCEPTED link whose account has no derivable last4. An order with no
// accepted link at all has no linked account to consult, so it fell through
// to being excluded on its own last4 alone -- even when EVERY account in the
// household is opaque (e.g. every card is a non-numeric short_code) and
// there is therefore no basis to call anything foreign, linked or not. This
// mirrors loadItemAllocations.ts's per-link guard, extended to the
// household level so it also covers orders with no link.
test('a household where no account can derive a last4 shows an unlinked Amazon order too', async () => {
  // Every account's short_code is opaque (non-numeric) -- last4Map ends up
  // empty. Nothing in this household has a basis for the comparison, so no
  // order should ever classify foreign, regardless of link status.
  await makeAccount('costco');
  const order = await makeOrder('amazon', '4321', 'k-no-basis-household-1');
  await makeItem(order.id, 'NoBasisWidget');

  const res = await request(app).get('/api/items');
  assert.equal(res.status, 200);
  const titles = res.body.items.map((r: { title: string }) => r.title);
  assert.equal(
    titles.includes('NoBasisWidget'),
    true,
    'no account in this household can derive a last4, so nothing has a basis for comparison',
  );
});

test('a household where no account can derive a last4 does not hide items/analyze either', async () => {
  await makeAccount('costco');
  const order = await makeOrder('amazon', '4321', 'k-no-basis-household-2');
  await makeItem(order.id, 'NoBasisAnalyzeWidget');

  const res = await request(app).get('/api/items/analyze');
  assert.equal(res.status, 200);
  const names = res.body.topItems.map((r: { name: string }) => r.name.toLowerCase());
  assert.equal(names.includes('nobasisanalyzewidget'), true);
});

// ─── FIX 5: soft-deleted (merged-away) orders must not surface here ───────
//
// ExternalOrder is now paranoid (docs/superpowers/specs/2026-09-11-account-
// card-identifiers-design.md, Part 5). loadItemAllocationContext already has
// a regression test proving a soft-deleted order never reaches an
// allocation total (backend/src/summary/loadItemAllocations.test.ts), but
// the Items page queries ExternalOrder/ExternalOrderItem directly and is
// not covered by that chokepoint, so it needs its own coverage of all three
// endpoints.
test('GET /api/items omits items from a soft-deleted order', async () => {
  const order = await makeOrder('amazon', null, 'k-soft-deleted-items');
  await makeItem(order.id, 'SoftDeletedItemsWidget');
  await models.ExternalOrder.destroy({ where: { id: order.id } });

  const res = await request(app).get('/api/items');
  assert.equal(res.status, 200);
  const titles = res.body.items.map((r: { title: string }) => r.title);
  assert.equal(titles.includes('SoftDeletedItemsWidget'), false);
});

test('GET /api/items/analyze omits items from a soft-deleted order', async () => {
  const order = await makeOrder('amazon', null, 'k-soft-deleted-analyze');
  await makeItem(order.id, 'SoftDeletedAnalyzeWidget');
  await models.ExternalOrder.destroy({ where: { id: order.id } });

  const res = await request(app).get('/api/items/analyze');
  assert.equal(res.status, 200);
  const names = res.body.topItems.map((r: { name: string }) => r.name.toLowerCase());
  assert.equal(names.includes('softdeletedanalyzewidget'), false);
});

test('GET /api/items/analyze/trend omits points from a soft-deleted order', async () => {
  const order = await makeOrder('amazon', null, 'k-soft-deleted-trend');
  await makeItem(order.id, 'SoftDeletedTrendWidget');
  await models.ExternalOrder.destroy({ where: { id: order.id } });

  const res = await request(app)
    .get('/api/items/analyze/trend')
    .query({ itemName: 'SoftDeletedTrendWidget' });
  assert.equal(res.status, 200);
  assert.equal(res.body.points.length, 0);
});
