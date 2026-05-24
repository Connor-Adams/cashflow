import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { extractPdfLines } from '../src/import/pdf/extractLines';
import {
  costcoTillReceiptParser,
  buildCostcoOrderId,
  findCostcoFooter,
  parseCostcoTenders,
} from '../src/import/pdf/receipts/costcoTillReceipt';

const fixturesDir = join(__dirname, 'fixtures', 'pdf');
const hasFixtures = existsSync(join(fixturesDir, 'costco-till-2025-12-13.pdf'));
const skipNoFixtures = hasFixtures
  ? undefined
  : 'Costco till PDF fixtures not present (gitignored — see backend/test/fixtures/pdf/)';

async function loadLines(name: string) {
  const buf = await readFile(join(fixturesDir, name));
  return extractPdfLines(buf);
}

test('buildCostcoOrderId composes a stable id from footer fields', () => {
  assert.equal(
    buildCostcoOrderId('1168', '11', '303', '23', '20251213', '1624'),
    '1168-11-303-23-20251213-1624',
  );
});

test('findCostcoFooter parses the date/time/whse/trm/trn/opt line', () => {
  const f = findCostcoFooter([' 12/13/2025   16:24   1168   11   303   23']);
  assert.deepEqual(f, {
    orderDate: '2025-12-13',
    hhmm: '1624',
    whse: '1168',
    trm: '11',
    trn: '303',
    opt: '23',
  });
});

test('findCostcoFooter returns null when no date line present', () => {
  assert.equal(findCostcoFooter([' INSTANT SAVINGS   $203.00']), null);
});

test('parseCostcoTenders pairs cards to tenders by order, leaves extras null', () => {
  const texts = [
    ' XXXXXXXXXXXXX3812   CHIP read',
    ' MASTER CARD   1,863.72',
    ' COSTCO MASTERCARD   1,100.00',
    ' CHANGE   0',
  ];
  const { cards, tenderRows } = parseCostcoTenders(texts, -1);
  assert.deepEqual(cards, ['3812']);
  assert.equal(tenderRows.length, 2);
  assert.deepEqual(
    tenderRows.map((t) => ({ name: t.name, amount: t.amount })),
    [
      { name: 'MASTER CARD', amount: 1863.72 },
      { name: 'COSTCO MASTERCARD', amount: 1100.0 },
    ],
  );
});

test('costcoTillReceiptParser.sniff matches a Costco receipt and rejects unrelated PDFs', () => {
  const costcoLines = [
    { page: 1, y: 700, text: 'GUELPH #1168' },
    { page: 2, y: 100, text: ' Items Sold: 9' },
  ];
  const nonCostco = [
    { page: 1, y: 700, text: 'CIBC Costco Mastercard' },
    { page: 1, y: 600, text: 'Some statement text' },
  ];
  assert.equal(costcoTillReceiptParser.sniff(costcoLines), true);
  assert.equal(costcoTillReceiptParser.sniff(nonCostco), false);
});

test('Costco R1 — single-tender (2025-12-13, $947.04)', { skip: skipNoFixtures }, async () => {
  const lines = await loadLines('costco-till-2025-12-13.pdf');
  const { extracted, warnings } = costcoTillReceiptParser.parse(lines, { defaultCurrency: 'CAD' });

  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);
  assert.equal(extracted.vendor, 'costco');
  assert.equal(extracted.vendorName, 'Costco GUELPH #1168');
  assert.equal(extracted.orderDate, '2025-12-13');
  assert.equal(extracted.orderId, '1168-11-303-23-20251213-1624');
  assert.equal(extracted.subtotal, 849.81);
  assert.equal(extracted.tax, 97.23);
  assert.equal(extracted.total, 947.04);
  assert.equal(extracted.currency, 'CAD');
  assert.equal(extracted.paymentLast4, '3114');

  assert.equal(extracted.tenders.length, 1);
  assert.deepEqual(extracted.tenders[0], {
    paymentLast4: '3114',
    network: 'costco-mastercard',
    amount: 947.04,
  });

  // 9 catalog items + 2 TPD discount lines = 11 line items
  assert.equal(extracted.items.length, 11);

  // Spot-check an unambiguous item
  const hero = extracted.items.find((it) => it.vendorItemId === '1828317');
  assert.ok(hero, 'HERO item not found');
  assert.equal(hero.title, 'HERO');
  assert.equal(hero.totalPrice, 29.99);
  assert.equal(hero.taxable, true);

  // Wrap case: FRANKS / SAUCE
  const franks = extracted.items.find((it) => it.vendorItemId === '1145564');
  assert.ok(franks, 'FRANKS SAUCE item not found');
  assert.equal(franks.title, 'FRANKS SAUCE');
  assert.equal(franks.totalPrice, 9.99);
  assert.equal(franks.taxable, false);

  // TPD discount
  const dysonTpd = extracted.items.find((it) => it.vendorItemId === '2016825');
  assert.ok(dysonTpd, 'TPD/1711427 discount not found');
  assert.equal(dysonTpd.title, 'TPD/1711427');
  assert.equal(dysonTpd.totalPrice, -200.0);

  // Sum reconciles
  const sum = extracted.items.reduce((a, it) => a + (it.totalPrice ?? 0), 0);
  assert.ok(Math.abs(sum - 849.81) < 0.01, `items sum ${sum} != 849.81`);
});

test('Costco R2 — split-tender (2025-12-26, $2,963.72 on 2 cards, 17 items)', {
  skip: skipNoFixtures,
}, async () => {
  const lines = await loadLines('costco-till-2025-12-26.pdf');
  const { extracted, warnings } = costcoTillReceiptParser.parse(lines, { defaultCurrency: 'CAD' });

  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);
  assert.equal(extracted.vendor, 'costco');
  assert.equal(extracted.orderDate, '2025-12-26');
  assert.equal(extracted.orderId, '1168-7-285-17-20251226-1546');
  assert.equal(extracted.subtotal, 2628.43);
  assert.equal(extracted.tax, 335.29);
  assert.equal(extracted.total, 2963.72);

  // Split tender: 2 tenders. Costco MC gets no last4 (no printed mask).
  assert.equal(extracted.tenders.length, 2);
  assert.deepEqual(extracted.tenders, [
    { paymentLast4: '3812', network: 'mastercard', amount: 1863.72 },
    { paymentLast4: null, network: 'costco-mastercard', amount: 1100.0 },
  ]);
  // Multi-tender → top-level paymentLast4 is null (matcher must use tenders[]).
  assert.equal(extracted.paymentLast4, null);

  // Items: 20 catalog rows + 5 TPD discount rows = 21 items? Receipt lists
  // 17 items sold; ours counts every numeric line including TPD + deposit.
  // Sanity check via subtotal.
  const sum = extracted.items.reduce((a, it) => a + (it.totalPrice ?? 0), 0);
  assert.ok(
    Math.abs(sum - 2628.43) < 0.01,
    `items sum ${sum.toFixed(2)} != 2628.43`,
  );

  // Wrap case: DEPOSIT / VL/1945087
  const deposit = extracted.items.find((it) => it.vendorItemId === '2521');
  assert.ok(deposit, 'bottle deposit item not found');
  assert.equal(deposit.title, 'DEPOSIT VL/1945087');
  assert.equal(deposit.totalPrice, 4.8);
  assert.equal(deposit.taxable, null); // no Y/N flag on deposit lines

  // Comma-thousands amount
  const tv = extracted.items.find((it) => it.vendorItemId === '9408277');
  assert.ok(tv, 'LG OLED77B5 not found');
  assert.equal(tv.title, 'LG OLED77B5');
  assert.equal(tv.totalPrice, 2496.99);
});
