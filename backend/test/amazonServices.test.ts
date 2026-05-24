import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonReportCsv } from '../src/amazon/parseAmazonReportCsv';
import { categorizeAmazonItem } from '../src/amazon/categories';
import { scoreAmazonOrderMatch } from '../src/amazon/matcher';
import { parseAmazonItemCategorySuggestions } from '../src/amazon/aiCategorizeAmazonItems';
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

test('CSV parser handles Amazon data export order history columns', () => {
  const csv = [
    'ASIN,Currency,Order Date,Order ID,Original Quantity,Payment Method Type,Product Name,Ship Date,Shipment Item Subtotal,Shipment Item Subtotal Tax,Shipping Charge,Total Amount,Unit Price,Unit Price Tax',
    'B000000001,CAD,2026-01-25T16:01:44Z,701-0000000-0000001,1,AmericanExpress - 1001,Ergonomic Wrist Rest,2026-01-25T20:40:47Z,43.92,5.71,0,49.63,43.92,5.71',
  ].join('\n');
  const result = parseAmazonReportCsv(csv);
  assert.equal(result.failedRows.length, 0);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].vendorOrderId, '701-0000000-0000001');
  assert.equal(result.orders[0].paymentLast4, '1001');
  assert.equal(result.orders[0].total, 49.63);
  assert.equal(result.orders[0].items[0].title, 'Ergonomic Wrist Rest');
});

test('fallback categorizer works', () => {
  assert.equal(categorizeAmazonItem('USB-C monitor cable'), 'Office Equipment');
  assert.equal(categorizeAmazonItem('protein coffee snacks'), 'Meals & Groceries');
  assert.equal(categorizeAmazonItem('laundry detergent'), 'Household');
  assert.equal(categorizeAmazonItem('toothpaste'), 'Personal');
  assert.equal(categorizeAmazonItem('unknown thing'), 'Uncategorized');
});

test('AI item categorization parser validates category and numeric fields', () => {
  const suggestions = parseAmazonItemCategorySuggestions(
    {
      items: [
        {
          itemId: 10,
          category: 'Office Equipment',
          businessUsePercent: 80,
          confidence: 92,
          rationale: 'Work peripheral.',
        },
        {
          itemId: 11,
          category: 'Not Real',
          businessUsePercent: 150,
          confidence: -10,
          rationale: '',
        },
        { itemId: 999, category: 'Software' },
      ],
    },
    [
      { id: 10, title: 'USB-C Cable' },
      { id: 11, title: 'Coffee Beans' },
    ],
    ['Computer Gear', 'Groceries'],
  );
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].category, 'Office Equipment');
  assert.equal(suggestions[0].businessUsePercent, 80);
  assert.equal(suggestions[0].confidence, 92);
  assert.equal(suggestions[0].usedExistingCategory, false);
  assert.equal(suggestions[1].category, 'Groceries');
  assert.equal(suggestions[1].businessUsePercent, 100);
  assert.equal(suggestions[1].confidence, 0);
  assert.equal(suggestions[1].usedExistingCategory, true);
});

test('AI item categorization parser preserves existing and new category labels', () => {
  const suggestions = parseAmazonItemCategorySuggestions(
    {
      items: [
        { itemId: 10, category: 'groceries', confidence: 90 },
        { itemId: 11, category: 'Camera Gear', confidence: 80 },
      ],
    },
    [
      { id: 10, title: 'Coffee Beans' },
      { id: 11, title: 'Pentax Film Camera' },
    ],
    ['Groceries', 'Office Supplies'],
  );
  assert.equal(suggestions[0].category, 'Groceries');
  assert.equal(suggestions[0].usedExistingCategory, true);
  assert.equal(suggestions[1].category, 'Camera Gear');
  assert.equal(suggestions[1].usedExistingCategory, false);
});

test('AI item categorization parser remaps fallback labels to existing categories', () => {
  const suggestions = parseAmazonItemCategorySuggestions(
    {
      items: [
        { itemId: 10, category: 'Uncategorized', confidence: 90, rationale: 'Food item.' },
        { itemId: 11, category: 'Uncategorized', confidence: 50, rationale: 'Game accessory.' },
        { itemId: 12, category: 'Household', confidence: 80, rationale: 'Home item.' },
        { itemId: 13, category: 'Office Equipment', confidence: 85, rationale: 'Computer accessory.' },
      ],
    },
    [
      { id: 10, title: 'Torani Vanilla Syrup' },
      { id: 11, title: 'Wii Remote Controller' },
      { id: 12, title: 'Bathroom Storage Cabinet' },
      { id: 13, title: 'USB-C Monitor Cable' },
    ],
    ['Coffee', 'Games', 'House', 'Desk', 'Laptop'],
  );
  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.category),
    ['Coffee', 'Games', 'House', 'Desk'],
  );
  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.usedExistingCategory),
    [true, true, true, true],
  );
});

test('AI item categorization parser avoids broad substring remaps', () => {
  const suggestions = parseAmazonItemCategorySuggestions(
    {
      items: [
        { itemId: 10, category: 'Uncategorized', confidence: 60, rationale: 'Skin care.' },
        { itemId: 11, category: 'Travel', confidence: 60, rationale: 'Travel accessory.' },
        { itemId: 12, category: 'Uncategorized', confidence: 60, rationale: 'Cable mentions gaming.' },
        { itemId: 13, category: 'Uncategorized', confidence: 60, rationale: 'Coffee shop wording.' },
      ],
    },
    [
      { id: 10, title: 'Cetaphil Gentle Skin Cleansing Cloths' },
      { id: 11, title: 'Travel Toothbrush Kit' },
      { id: 12, title: 'HDMI Cable for PS5 Gaming' },
      { id: 13, title: 'Gold Napkin Holder for Coffee Shop Counter' },
    ],
    ['Snowboarding Gear', 'ESim', 'Games', 'Desk', 'Coffee'],
  );
  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.category),
    ['Uncategorized', 'Travel', 'Uncategorized', 'Uncategorized'],
  );
  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.usedExistingCategory),
    [false, false, false, false],
  );
});

test('AI item categorization parser prioritizes specific existing category matches', () => {
  const suggestions = parseAmazonItemCategorySuggestions(
    {
      items: [
        { itemId: 10, category: 'Meals & Groceries', confidence: 80 },
        { itemId: 11, category: 'Office Equipment', confidence: 80 },
      ],
    },
    [
      { id: 10, title: 'Cheez-It Baked Snack Crackers' },
      { id: 11, title: 'USB C Cable compatible with phones and Oculus Quest' },
    ],
    ['Coffee', 'Games', 'Groceries'],
  );
  assert.equal(suggestions[0].category, 'Groceries');
  assert.equal(suggestions[0].usedExistingCategory, true);
  assert.equal(suggestions[1].category, 'Office Equipment');
  assert.equal(suggestions[1].usedExistingCategory, false);
});

test('AI item categorization parser does not infer Laptop from compatibility text', () => {
  const suggestions = parseAmazonItemCategorySuggestions(
    {
      items: [
        { itemId: 10, category: 'Office Equipment', confidence: 80 },
      ],
    },
    [
      { id: 10, title: 'USB C Cable Compatible with MacBook Pro and iPad' },
    ],
    ['Laptop', 'Desk'],
  );
  assert.equal(suggestions[0].category, 'Office Equipment');
  assert.equal(suggestions[0].usedExistingCategory, false);
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
    sourceIdentityFingerprint: 'identity-fp',
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
