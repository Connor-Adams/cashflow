import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePurchaseHistoryCsv } from './parsePurchaseHistoryCsv';

test('parses Apple-style purchase-history CSV with header variants', () => {
  const csv = [
    'Purchase Date,Item Description,Cost,Currency,Order ID',
    '2026-04-15,Apple Music Individual,11.99,USD,ABC-123',
    '2026-04-16,iCloud+ 200 GB,3.99,USD,DEF-456',
  ].join('\n');

  const result = parsePurchaseHistoryCsv(csv, { vendor: 'apple' });

  assert.equal(result.vendor, 'apple');
  assert.equal(result.totalRows, 2);
  assert.equal(result.orders.length, 2);

  const a = result.orders[0];
  assert.equal(a.orderDate, '2026-04-15');
  assert.equal(a.total, 11.99);
  assert.equal(a.currency, 'USD');
  assert.equal(a.orderId, 'ABC-123');
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].title, 'Apple Music Individual');

  // Column mapping should expose what was recognised
  assert.equal(result.columnMapping['Purchase Date'], 'date');
  assert.equal(result.columnMapping['Item Description'], 'title');
  assert.equal(result.columnMapping['Cost'], 'amount');
});

test('parses Google-style headers (Title / Amount / Date / Order Number)', () => {
  const csv = [
    'Date,Title,Amount,Order Number',
    '2026-05-01,YouTube Premium,11.99,GP-789',
    '2026-05-02,Pixel 8 case,29.00,GP-790',
  ].join('\n');

  const result = parsePurchaseHistoryCsv(csv, { vendor: 'google', defaultCurrency: 'USD' });

  assert.equal(result.orders.length, 2);
  assert.equal(result.orders[0].items[0].title, 'YouTube Premium');
  assert.equal(result.orders[0].total, 11.99);
  assert.equal(result.orders[0].currency, 'USD');
  assert.equal(result.orders[1].orderId, 'GP-790');
});

test('skips rows missing both title and amount', () => {
  const csv = [
    'Date,Description,Amount',
    '2026-05-10,,',
    '2026-05-11,Real Item,5.00',
    ',,',
  ].join('\n');

  const result = parsePurchaseHistoryCsv(csv, { vendor: 'other' });

  assert.equal(result.totalRows, 3);
  assert.equal(result.orders.length, 1);
  assert.equal(result.unparsedRows, 2);
});

test('amount with currency symbols and commas is parsed', () => {
  const csv = [
    'Order Date,Item,Cost',
    '2026-05-15,Big Item,"$1,299.00"',
  ].join('\n');

  const result = parsePurchaseHistoryCsv(csv, { vendor: 'apple' });
  assert.equal(result.orders[0].total, 1299);
});

test('amount with alphabetic currency prefixes (CA$, US$, USD) is parsed', () => {
  const csv = [
    'Date,Title,Amount',
    '2026-05-01,YouTube Premium,CA$13.99',
    '2026-05-02,Pixel Game,US$1.99',
    '2026-05-03,Movie Rental,USD 5.99',
  ].join('\n');

  const result = parsePurchaseHistoryCsv(csv, { vendor: 'google' });
  assert.deepEqual(
    result.orders.map((o) => o.total),
    [13.99, 1.99, 5.99],
  );
});

test('appends subtitle (developer/publisher) to title for context', () => {
  const csv = [
    'Date,App Name,Developer,Cost',
    '2026-05-20,Widgetsmith,Cross Forward,4.99',
  ].join('\n');

  const result = parsePurchaseHistoryCsv(csv, { vendor: 'apple' });
  assert.equal(result.orders.length, 1);
  assert.match(result.orders[0].items[0].title, /Widgetsmith.*Cross Forward/);
});

test('empty CSV returns empty result without throwing', () => {
  const result = parsePurchaseHistoryCsv('', { vendor: 'other' });
  assert.equal(result.totalRows, 0);
  assert.equal(result.orders.length, 0);
});
