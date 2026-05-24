import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerReceiptPdfParser,
  findReceiptPdfParser,
  clearReceiptPdfParsersForTest,
  registerBuiltInReceiptPdfParsers,
} from '../src/import/pdf/receipts/registry';
import type { ReceiptPdfParser } from '../src/import/pdf/receipts/types';

function makeFakeParser(id: string, sniff: (lines: { text: string }[]) => boolean): ReceiptPdfParser {
  return {
    id,
    label: `fake-${id}`,
    sniff: sniff as ReceiptPdfParser['sniff'],
    parse: () => ({
      extracted: {
        vendor: 'other',
        vendorName: null,
        orderDate: null,
        orderId: null,
        subtotal: null,
        tax: null,
        total: null,
        currency: null,
        paymentLast4: null,
        tenders: [],
        items: [],
        notes: null,
      },
      warnings: [],
    }),
  };
}

test('findReceiptPdfParser returns null when no parser matches', () => {
  clearReceiptPdfParsersForTest();
  const fake = makeFakeParser('never-sniffs', () => false);
  registerReceiptPdfParser(fake);
  assert.equal(findReceiptPdfParser([{ page: 1, y: 0, text: 'irrelevant' }]), null);
  clearReceiptPdfParsersForTest();
});

test('findReceiptPdfParser returns the first sniffing parser in registration order', () => {
  clearReceiptPdfParsersForTest();
  const a = makeFakeParser('a', (lines) => lines.some((l) => l.text === 'first'));
  const b = makeFakeParser('b', () => true);
  registerReceiptPdfParser(a);
  registerReceiptPdfParser(b);
  const match = findReceiptPdfParser([{ page: 1, y: 0, text: 'first' }]);
  assert.equal(match?.id, 'a');
  clearReceiptPdfParsersForTest();
});

test('registerReceiptPdfParser throws on duplicate id', () => {
  clearReceiptPdfParsersForTest();
  registerReceiptPdfParser(makeFakeParser('dup', () => true));
  assert.throws(() => registerReceiptPdfParser(makeFakeParser('dup', () => true)));
  clearReceiptPdfParsersForTest();
});

test('registerBuiltInReceiptPdfParsers is idempotent', () => {
  clearReceiptPdfParsersForTest();
  registerBuiltInReceiptPdfParsers();
  registerBuiltInReceiptPdfParsers(); // should NOT throw on duplicate registration
  assert.ok(findReceiptPdfParser([
    { page: 1, y: 700, text: 'GUELPH #1168' },
    { page: 2, y: 100, text: 'Items Sold: 5' },
  ]));
  clearReceiptPdfParsersForTest();
});
