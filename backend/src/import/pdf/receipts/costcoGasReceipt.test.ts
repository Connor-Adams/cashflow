import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costcoGasReceiptParser, buildCostcoGasOrderId } from './costcoGasReceipt';
import type { PdfLine } from '../types';

/**
 * Synthetic Costco gas "Transaction Record". Real line shapes, invented member
 * number and card. Committable to a public repo and always runs in CI.
 */
function gasLines(over: Partial<{ fuelSale: string; amt: string; hst: string; time: string; invoice: string }> = {}): PdfLine[] {
  const texts = [
    'Transaction Record',
    ' Guelph #1168',
    ' 19 ELMIRA RD S',
    ' GUELPH, ON N1K 0B6',
    ' Member# 999999999999',
    ' Pump:   14',
    ' Grade:   Premium',
    ' Ltrs:   33.036',
    ' Price/Ltrs:   $1.48',
    ` Fuel Sale   $${over.fuelSale ?? '48.86'}`,
    ' Transaction#:',
    ` HST Included =   $${over.hst ?? '5.62'}`,
    ' HST #121476329',
    ' Type: Sales',
    ' MASTERCARD',
    ' ************3114',
    ` Amt:   $${over.amt ?? '48.86'}`,
    ' Date:   2026/02/22',
    ` Time:   ${over.time ?? '13:52:00'}`,
    ' Term:   0',
    ' Ref:   0010012790',
    ' Auth:   01549Z',
    ' 01 APPROVED 000',
    ` Invoice Number: ${over.invoice ?? '12790'}`,
    ' No Signature Transaction',
    ' *** Customer Copy ***',
  ];
  return texts.map((text, i) => ({ page: 1, y: 684 - i * 13.5, text }));
}

/** A till receipt must not be claimed by the gas parser. */
function tillLines(): PdfLine[] {
  return [
    { page: 1, y: 700, text: 'GUELPH #1168' },
    { page: 1, y: 680, text: ' 1951340   TIDE F&G   24.99 Y' },
    { page: 1, y: 660, text: 'SUBTOTAL              24.99' },
    { page: 2, y: 100, text: ' Items Sold: 1' },
  ];
}

test('sniff matches a gas Transaction Record and rejects a till receipt', () => {
  assert.equal(costcoGasReceiptParser.sniff(gasLines()), true);
  assert.equal(costcoGasReceiptParser.sniff(tillLines()), false);
  assert.equal(costcoGasReceiptParser.sniff([{ page: 1, y: 1, text: 'CIBC Costco Mastercard' }]), false);
});

test('buildCostcoGasOrderId composes a stable id from warehouse, invoice, date and time', () => {
  assert.equal(buildCostcoGasOrderId('1168', '12790', '20260222', '1352'), '1168-gas-12790-20260222-1352');
});

test('HST is treated as included, so subtotal is total minus tax', () => {
  const { extracted, warnings } = costcoGasReceiptParser.parse(gasLines(), { defaultCurrency: 'CAD' });

  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);
  assert.equal(extracted.total, 48.86);
  assert.equal(extracted.tax, 5.62);
  assert.equal(extracted.subtotal, 43.24);
  assert.equal(extracted.currency, 'CAD');
  assert.equal(extracted.vendor, 'costco');
  assert.equal(extracted.vendorName, 'Costco Guelph #1168');
  assert.equal(extracted.orderDate, '2026-02-22');
  assert.equal(extracted.orderId, '1168-gas-12790-20260222-1352');
});

test('the card mask uses asterisks, not the X-prefixed till format', () => {
  const { extracted } = costcoGasReceiptParser.parse(gasLines(), { defaultCurrency: 'CAD' });

  assert.equal(extracted.paymentLast4, '3114');
  assert.deepEqual(extracted.tenders, [
    { paymentLast4: '3114', network: 'mastercard', amount: 48.86 },
  ]);
});

test('the fuel sale becomes one pre-tax line item naming grade, litres and unit price', () => {
  const { extracted } = costcoGasReceiptParser.parse(gasLines(), { defaultCurrency: 'CAD' });

  assert.equal(extracted.items.length, 1);
  const [fuel] = extracted.items;
  // quantity is an INTEGER column, so litres belong in the title, not the quantity.
  assert.equal(fuel.quantity, 1);
  assert.match(fuel.title, /Premium/);
  assert.match(fuel.title, /33\.036/);
  assert.match(fuel.title, /1\.48/);
  assert.equal(fuel.title, 'Premium fuel — 33.036 L @ $1.48/L');
  assert.equal(fuel.taxable, true);
  // Pre-tax, so items sum to SUBTOTAL exactly as they do on a till receipt.
  assert.equal(fuel.totalPrice, 43.24);
  assert.equal(fuel.unitPrice, 43.24);
});

test('two fills on the same day get different order ids', () => {
  const a = costcoGasReceiptParser.parse(gasLines({ invoice: '10290', time: '13:42:00' }), { defaultCurrency: 'CAD' });
  const b = costcoGasReceiptParser.parse(gasLines({ invoice: '12790', time: '13:52:00' }), { defaultCurrency: 'CAD' });

  assert.equal(a.extracted.orderId, '1168-gas-10290-20260222-1342');
  assert.equal(b.extracted.orderId, '1168-gas-12790-20260222-1352');
  assert.notEqual(a.extracted.orderId, b.extracted.orderId);
});

test('a charged amount that disagrees with the fuel sale is warned, not silently taken', () => {
  const { warnings } = costcoGasReceiptParser.parse(
    gasLines({ fuelSale: '48.86', amt: '40.00' }),
    { defaultCurrency: 'CAD' },
  );
  assert.equal(warnings.length, 1, `warnings: ${warnings.join('; ')}`);
  assert.match(warnings[0], /48\.86.*40\.00|40\.00.*48\.86/);
});

test('tax that does not reconcile against the total is warned', () => {
  const { warnings } = costcoGasReceiptParser.parse(
    gasLines({ hst: '99.99' }),
    { defaultCurrency: 'CAD' },
  );
  assert.ok(warnings.length >= 1, 'expected a reconciliation warning');
});
