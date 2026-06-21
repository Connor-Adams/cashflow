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
import type { ExtractedReceiptOrder } from '../ai/extractReceiptItems';
import { defaultCurrency } from '../config/env';

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
