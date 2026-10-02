/**
 * Currency-fallback tests for the external-orders persist path.
 *
 * Missing-currency receipts/orders must fall back to the household/app default
 * currency (DEFAULT_CURRENCY, = 'CAD'), NOT a hardcoded 'USD'. A fabricated USD
 * makes the receipt matcher's -40 currency penalty kill otherwise-perfect
 * matches against CAD card rows. See externalOrders.ts persistExtractedOrder
 * and the import-csv route's parsePurchaseHistoryCsv default.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractedReceiptItem, ExtractedReceiptOrder } from '../ai/extractReceiptItems';
import { defaultCurrency } from '../config/env';
import { buildExternalOrderItemRows } from '../import/externalOrderItemRows';
import {
  assertInferredCategoriesResolved,
  assertNoHouseholdFallback,
  inferredCategoryFixtureItems,
} from '../../test/helpers/inferredCategoryFixture';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let persistExtractedOrder: typeof import('./externalOrders').persistExtractedOrder;

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  persistExtractedOrder = (await import('./externalOrders')).persistExtractedOrder;
});

after(async () => {
  await models.sequelize.close();
});

function baseOrder(overrides: Partial<ExtractedReceiptOrder> = {}): ExtractedReceiptOrder {
  return {
    vendor: 'other',
    orderDate: '2026-06-01',
    orderId: null,
    subtotal: null,
    tax: null,
    total: 12.34,
    currency: null,
    paymentLast4: null,
    tenders: [],
    items: [],
    ...overrides,
  };
}

test('persistExtractedOrder defaults a missing currency to the household default (CAD), not USD', async () => {
  const { order } = await persistExtractedOrder(baseOrder({ currency: null, orderId: 'no-ccy-1' }), {
    userId: null,
    householdId: null,
    source: 'test',
  });
  assert.equal(order.currency, defaultCurrency);
  assert.equal(defaultCurrency, 'CAD');
  assert.notEqual(order.currency, 'USD');
});

test('persistExtractedOrder preserves an explicitly extracted currency', async () => {
  const { order } = await persistExtractedOrder(baseOrder({ currency: 'USD', orderId: 'with-ccy-1' }), {
    userId: null,
    householdId: null,
    source: 'test',
  });
  assert.equal(order.currency, 'USD');
});

// ---------------------------------------------------------------------------
// Category FK on the ordinary receipt-ingest path
// ---------------------------------------------------------------------------
//
// `persistExtractedOrder` is the shared seam behind five routes (receipt photo
// analysis, paste-text, CSV import, single- and bulk-PDF import). Its
// `ExternalOrderItem.bulkCreate` is a STATIC write with no `individualHooks`,
// so the `beforeSave` hook on the model — the thing that reconciles
// `inferred_category` into `inferred_category_id` — never runs for it. Left
// alone it writes the string mirror with a NULL id on every ingest, and would
// keep re-breaking the rows the repair migration fixes.
//
// The category value here is NOT always a flat parser label: the AI extractors
// (`extractReceiptFromText` / `extractReceiptFromImage`) and the user's own
// purchase-history CSV both hand this path an unconstrained string, so a
// path-form value like "Household / Rent" is reachable and must never land in
// `inferred_category` verbatim — every budget and spend rollup joins that
// column as an exact string.

function itemFor(over: Partial<ExtractedReceiptItem> = {}): ExtractedReceiptItem {
  return { title: 'Thing', quantity: 1, unitPrice: 1, totalPrice: 1, inferredCategory: null, ...over };
}

test('persistExtractedOrder resolves every item category to its leaf id and a FLAT name', async () => {
  const household = await models.Household.create({ name: 'Ingest FK' } as never);
  const house = await models.Category.create({
    householdId: household.id, name: 'Household', parentId: null,
  } as never);
  const rent = await models.Category.create({
    householdId: household.id, name: 'Rent', parentId: house.id,
  } as never);

  const { order, created } = await persistExtractedOrder(
    baseOrder({ orderId: 'fk-resolve-1', items: inferredCategoryFixtureItems() }),
    { userId: null, householdId: household.id, source: 'test' },
  );
  assert.equal(created, true);
  await assertInferredCategoriesResolved({
    externalOrderId: order.id, householdId: household.id, rentId: rent.id,
  });
});

test('persistExtractedOrder with no household stores the leaf segment and a null id', async () => {
  // (c) No household means nothing to resolve against, but the raw string must
  // still not be written — the fallback is the LAST PATH SEGMENT.
  const { order } = await persistExtractedOrder(
    baseOrder({
      orderId: 'fk-nohousehold-1',
      items: [itemFor({ title: 'Rent', inferredCategory: 'Household / Rent' })],
    }),
    { userId: null, householdId: null, source: 'test' },
  );
  await assertNoHouseholdFallback(order.id);
});

test('a 30-item receipt resolves each DISTINCT category name once, not once per item', async () => {
  // This is a BULK write: resolving inside the row loop would turn one
  // bulkCreate into one resolution per item. ensureCategory costs two SELECTs
  // against `categories` for an existing flat name (the name lookup plus the
  // leaf load), so 30 items across 6 categories must cost 12 category queries,
  // not 60.
  const household = await models.Household.create({ name: 'Batch count' } as never);
  const names = ['Groceries', 'Coffee', 'Household', 'Transport', 'Pharmacy', 'Pets'];
  for (const name of names) {
    await models.Category.create({ householdId: household.id, name, parentId: null } as never);
  }
  const items = Array.from({ length: 30 }, (_, i) =>
    itemFor({ title: `line ${i}`, inferredCategory: names[i % names.length] }),
  );

  const sql: string[] = [];
  const original = models.sequelize.options.logging;
  models.sequelize.options.logging = (line: string) => { sql.push(line); };
  try {
    await persistExtractedOrder(baseOrder({ orderId: 'fk-batch-1', items }), {
      userId: null, householdId: household.id, source: 'test',
    });
  } finally {
    models.sequelize.options.logging = original;
  }

  const categoryReads = sql.filter((line) => /FROM\s+[`"[]?categories/i.test(line));
  assert.equal(
    categoryReads.length,
    12,
    `expected 2 category SELECTs per DISTINCT name (6 names => 12), got ${categoryReads.length}`,
  );
  assert.equal(
    await models.Category.count({ where: { householdId: household.id } }),
    6,
    'no category is created for a name that already exists',
  );
});

test('the category resolve joins the caller transaction, so a rollback unwinds it', async () => {
  // All three ingest writers resolve INSIDE their `sequelize.transaction`, and
  // resolving CREATES missing categories. Without the transaction threaded
  // through, ensureCategory would commit on its own connection and an outer
  // rollback would leave the category behind as an orphan.
  const household = await models.Household.create({ name: 'Rollback' } as never);
  await assert.rejects(
    models.sequelize.transaction(async (t) => {
      const rows = await buildExternalOrderItemRows({
        externalOrderId: 1,
        householdId: household.id,
        items: [itemFor({ inferredCategory: 'Brand New Thing' })],
        transaction: t,
      });
      assert.ok(rows[0].inferredCategoryId != null, 'the resolve created and linked the category');
      throw new Error('simulated ingest failure');
    }),
    /simulated ingest failure/,
  );
  assert.equal(
    await models.Category.count({ where: { householdId: household.id } }),
    0,
    'the rolled-back transaction must leave no orphan category',
  );
});

test('persistExtractedOrder stores a null businessUsePercent even when the extractor supplied one', async () => {
  // This seam has always written null: an extracted guess must not feed the
  // business/tax split. Only scanInbox and persistHighConfidenceOrder carry it.
  const { order } = await persistExtractedOrder(
    baseOrder({ orderId: 'bup-null-1', items: [itemFor({ businessUsePercent: 60 })] }),
    { userId: null, householdId: null, source: 'test' },
  );
  const rows = await models.ExternalOrderItem.findAll({ where: { externalOrderId: order.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].businessUsePercent, null);
});
