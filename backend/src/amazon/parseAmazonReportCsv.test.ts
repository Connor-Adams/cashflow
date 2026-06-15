import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonReportCsv } from './parseAmazonReportCsv';

// Amazon "Retail.OrderHistory" data-export header. Note the gotcha (issue #557):
// "Shipment Item Subtotal" is the SHIPMENT's subtotal repeated on every item row
// in that shipment — NOT a per-line value and NOT the whole-order subtotal. The
// true per-line total is Unit Price * Quantity.
const DATA_EXPORT_HEADER =
  'ASIN,Currency,Order Date,Order ID,Original Quantity,Payment Method Type,Product Name,Ship Date,Shipment Item Subtotal,Shipment Item Subtotal Tax,Shipping Charge,Total Amount,Unit Price,Unit Price Tax';

function near(actual: number | null | undefined, expected: number, msg?: string) {
  assert.ok(actual != null, `${msg ?? ''} expected ~${expected}, got null`);
  assert.ok(
    Math.abs((actual as number) - expected) < 0.011,
    `${msg ?? ''} expected ~${expected}, got ${actual}`,
  );
}

// Defect 1 — per-item line total must NOT be overwritten with the shipment/order
// subtotal. Order 49 (real prod shape): two items in one shipment whose
// "Shipment Item Subtotal" (214.98) is repeated on both rows. Correct line totals
// are the per-item Unit Price * Quantity: 14.99 and 199.99 — distinct.
test('issue #557: per-item line totals stay distinct (order 49 shape)', () => {
  const csv = [
    DATA_EXPORT_HEADER,
    'B07K7HBZX2,CAD,2022-05-21T18:04:41Z,702-0133445-1893826,1,MasterCard - 2662,HDMI Cable,2022-05-22T00:50:06Z,214.98,27.95,0,16.94,14.99,1.95',
    'B0SHIELD01,CAD,2022-05-21T18:04:41Z,702-0133445-1893826,1,MasterCard - 2662,Nvidia Shield,2022-05-22T00:50:06Z,214.98,27.95,0,199.99,199.99,26.00',
  ].join('\n');
  const result = parseAmazonReportCsv(csv);
  assert.equal(result.failedRows.length, 0);
  assert.equal(result.orders.length, 1);
  const items = result.orders[0].items;
  assert.equal(items.length, 2);
  const totals = items.map((i) => i.totalPrice).sort((a, b) => Number(a) - Number(b));
  near(totals[0], 14.99, 'HDMI line total');
  near(totals[1], 199.99, 'Shield line total');
  // Distinct, not both = the shipment subtotal 214.98.
  assert.notEqual(items[0].totalPrice, items[1].totalPrice);
  // Σ(items) == subtotal (within rounding).
  near(result.orders[0].subtotal, 214.98, 'order 49 subtotal == sum of lines');
});

// Defect 2 — multi-shipment first-row-wins. Order 45 (real prod shape): 7 items
// across multiple shipments; "Shipment Item Subtotal" is a per-shipment value
// repeated on each item row (so it must NOT be summed, and the header subtotal
// must aggregate the true per-line totals across ALL rows, not just the first).
test('issue #557: multi-shipment order aggregates line totals across all rows (order 45 shape)', () => {
  const rows = [
    // unit price, unit price tax, shipment item subtotal, total amount, qty
    { up: 279.99, upt: 36.4, sis: '279.99', ta: 316.39, q: 1 },
    { up: 9.99, upt: 1.3, sis: '9.99', ta: 11.29, q: 1 },
    { up: 229.98, upt: 29.9, sis: '229.98', ta: 259.88, q: 1 },
    { up: 179.99, upt: 0, sis: 'Not Available', ta: 0, q: 0 },
    { up: 74.99, upt: 9.75, sis: '417.97', ta: 84.74, q: 1 },
    { up: 222.98, upt: 28.99, sis: '417.97', ta: 251.97, q: 1 },
    { up: 120.0, upt: 0, sis: '417.97', ta: 120.0, q: 1 },
  ];
  const csv = [
    DATA_EXPORT_HEADER,
    ...rows.map(
      (r, i) =>
        `B45000000${i},CAD,2019-01-01T00:00:00Z,702-3948956-8212261,${r.q},Visa - 1234,Part ${i},2019-01-02T00:00:00Z,${r.sis},${r.upt},0,${r.ta},${r.up},${r.upt}`,
    ),
  ].join('\n');
  const result = parseAmazonReportCsv(csv);
  assert.equal(result.failedRows.length, 0);
  assert.equal(result.orders.length, 1);
  const order = result.orders[0];
  assert.equal(order.items.length, 7);
  // Each line total = unit * max(1, qty); the qty=0 row floors to 1.
  const lineSum = 279.99 + 9.99 + 229.98 + 179.99 + 74.99 + 222.98 + 120.0; // 1117.92
  near(order.subtotal, lineSum, 'order 45 subtotal == Σ(line totals)');
  // Subtotal must NOT be the first-row value (279.99) nor Σ(repeated shipment subtotals).
  assert.notEqual(Math.round(Number(order.subtotal) * 100), Math.round(279.99 * 100));
  // Σ(items) == subtotal.
  const itemsSum = order.items.reduce((s, it) => s + Number(it.totalPrice ?? 0), 0);
  near(itemsSum, Number(order.subtotal), 'Σ(items) == subtotal');
});

// Defect 3 — $0 orders fall back to Σ(item line totals). Order 310 (real prod
// shape): cancelled Garmin, Total Amount=0, Shipment Item Subtotal=Not Available,
// Unit Price="1,609.99", Original Quantity=0.
test('issue #557: $0/empty-total order falls back to item sum (order 310 shape)', () => {
  const csv = [
    DATA_EXPORT_HEADER,
    'B0CGJXT7RB,CAD,2024-05-22T04:23:55Z,701-8924505-1757002,0,AmericanExpress - 1005,Garmin tactix 7,Not Available,Not Available,Not Available,0,0,"1,609.99",0',
  ].join('\n');
  const result = parseAmazonReportCsv(csv);
  assert.equal(result.failedRows.length, 0);
  assert.equal(result.orders.length, 1);
  const order = result.orders[0];
  assert.equal(order.items.length, 1);
  near(order.items[0].totalPrice, 1609.99, 'garmin line total');
  near(order.total, 1609.99, 'order 310 total falls back to item sum');
  near(order.subtotal, 1609.99, 'order 310 subtotal == item sum');
});

// Guard: a real CSV total must still win over the item-sum fallback (no clobber).
test('issue #557: real CSV total is preserved (fallback only when empty/zero)', () => {
  const csv = [
    'Order ID,Order Date,Title,Quantity,Item Total,Order Total',
    '701-9999999-9999999,2026-05-01,Gadget A,1,10.00,30.00',
    '701-9999999-9999999,2026-05-01,Gadget B,1,15.00,30.00',
  ].join('\n');
  const result = parseAmazonReportCsv(csv);
  assert.equal(result.orders.length, 1);
  const order = result.orders[0];
  // Item Total is a genuine per-line column → kept as-is.
  near(order.items[0].totalPrice, 10.0, 'line A');
  near(order.items[1].totalPrice, 15.0, 'line B');
  // Order Total (30.00) is order-level repeated → preserved, not summed.
  near(order.total, 30.0, 'order total preserved');
});
