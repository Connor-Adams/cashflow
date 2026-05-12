import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonReportCsv } from '../src/amazon/parseAmazonReportCsv';
import { categorizeAmazonItem } from '../src/amazon/categories';
import { scoreAmazonOrderMatch } from '../src/amazon/matcher';
import { ExternalOrder } from '../src/models/ExternalOrder';
import { Transaction } from '../src/models/Transaction';

test('CSV parser handles normal Amazon report', () => {
  const csv = [
    'Order ID,Order Date,Shipment Date,Title,Quantity,Item Total,Order Total,Payment Last 4',
    '701-1111111-1111111,2026-05-01,2026-05-02,USB-C Cable,2,12.50,25.00,1234',
    '701-1111111-1111111,2026-05-01,2026-05-02,Keyboard,1,12.50,25.00,1234',
  ].join('\n');
  const result = parseAmazonReportCsv(csv);
  assert.equal(result.failedRows.length, 0);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].items.length, 2);
  assert.equal(result.orders[0].items[0].inferredCategory, 'Office Equipment');
});

test('CSV parser handles missing optional columns', () => {
  const csv = 'Date,Item,Amount\n2026-05-01,Coffee Beans,18.99\n';
  const result = parseAmazonReportCsv(csv);
  assert.equal(result.failedRows.length, 0);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].total, 18.99);
  assert.equal(result.orders[0].currency, 'CAD');
});

test('CSV parser aggregates no-order-id rows before fallback dedupe hash', () => {
  const csv = [
    'Order Date,Title,Item Total,Order Total',
    '2026-05-01,USB-C Cable,12.00,24.00',
    '2026-05-01,Monitor Adapter,12.00,24.00',
  ].join('\n');
  const result = parseAmazonReportCsv(csv);
  assert.equal(result.failedRows.length, 0);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].items.length, 2);
  assert.match(result.orders[0].dedupeKey, /^amazon:fallback:/);
});

test('fallback categorizer works', () => {
  assert.equal(categorizeAmazonItem('USB-C monitor cable'), 'Office Equipment');
  assert.equal(categorizeAmazonItem('protein coffee snacks'), 'Meals & Groceries');
  assert.equal(categorizeAmazonItem('laundry detergent'), 'Household');
  assert.equal(categorizeAmazonItem('toothpaste'), 'Personal');
  assert.equal(categorizeAmazonItem('unknown thing'), 'Uncategorized');
});

test('matcher matches amount + nearby date and rejects wrong amount/date', () => {
  const txn = Transaction.build({
    id: 1,
    accountId: 1,
    householdId: 1,
    createdByUserId: 1,
    importBatch: 'test',
    date: '2026-05-05',
    merchantRaw: 'AMZN Mktp CA',
    merchantClean: 'AMZN Mktp CA',
    amount: '-42.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp',
  } as never);
  const good = ExternalOrder.build({
    id: 1,
    householdId: 1,
    vendor: 'amazon',
    dedupeKey: 'a',
    shipmentDate: '2026-05-02',
    total: '42.25',
    currency: 'CAD',
    source: 'amazon_report',
  } as never);
  const bad = ExternalOrder.build({
    id: 2,
    householdId: 1,
    vendor: 'amazon',
    dedupeKey: 'b',
    shipmentDate: '2026-04-01',
    total: '99.00',
    currency: 'CAD',
    source: 'amazon_report',
  } as never);
  assert.ok(scoreAmazonOrderMatch(txn, good).confidence >= 90);
  assert.ok(scoreAmazonOrderMatch(txn, bad).confidence < 70);
});
