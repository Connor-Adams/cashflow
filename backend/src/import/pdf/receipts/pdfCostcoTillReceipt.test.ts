// Fixture-loader and assertion boilerplate intentionally mirrors pdfCibcCostcoMastercard.test.ts.
// fallow-ignore-file code-duplication
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractPdfLines } from '../extractLines';
import {
  costcoTillReceiptParser,
  buildCostcoOrderId,
  classifyNetwork,
  findCostcoFooter,
  looksLikeNameFragment,
  parseCostcoTenders,
} from './costcoTillReceipt';
import { skipUnlessPrivateFixtures } from '../../../../test/helpers/privateFixtures';
import { synthPdfLines, type SynthPage } from '../../../../test/helpers/syntheticPdf';
import { SYN_COSTCO_R1, SYN_COSTCO_R2, SYN_COSTCO_R3 } from '../../../../test/helpers/syntheticStatements';

// The R1/R2/R3 tests read Connor's REAL receipts (gitignored under
// backend/test/fixtures/pdf/): LOCAL-ONLY, and in CI they skip with a loud
// reason. Each has a synthetic twin (test/helpers/syntheticStatements.ts,
// made-up values in the real layout) that always runs.
const backendRoot = join(__dirname, '..', '..', '..', '..');
const fixturesDir = join(backendRoot, 'test', 'fixtures', 'pdf');
/**
 * Skip reason for ONE fixture. Gating every test on a single file meant one
 * absent PDF silently disabled all of them.
 */
function skipUnless(name: string): string | undefined {
  return skipUnlessPrivateFixtures(join(fixturesDir, name));
}

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

test('classifyNetwork prefers more-specific Costco MC over generic Mastercard', () => {
  assert.equal(classifyNetwork('COSTCO MASTERCARD'), 'costco-mastercard');
  assert.equal(classifyNetwork('MASTER CARD'), 'mastercard');
  assert.equal(classifyNetwork('MASTERCARD'), 'mastercard');
  assert.equal(classifyNetwork('VISA DEBIT'), 'visa');
  assert.equal(classifyNetwork('AMERICAN EXPRESS'), 'amex');
  assert.equal(classifyNetwork('AMEX'), 'amex');
  assert.equal(classifyNetwork('DEBIT'), 'debit');
  assert.equal(classifyNetwork('CASH'), 'cash');
  assert.equal(classifyNetwork('Unknown'), null);
});

test('looksLikeNameFragment treats blank/structural lines as non-fragments', () => {
  assert.equal(looksLikeNameFragment(''), false);
  assert.equal(looksLikeNameFragment('   '), false);
  assert.equal(looksLikeNameFragment('SUBTOTAL   100.00'), false);
  assert.equal(looksLikeNameFragment('TAX   12.50'), false);
  assert.equal(looksLikeNameFragment('****   TOTAL   112.50'), false);
  assert.equal(looksLikeNameFragment('Member'), false);
  assert.equal(looksLikeNameFragment('Items Sold: 9'), false);
  assert.equal(looksLikeNameFragment('CHANGE   0'), false);
  assert.equal(looksLikeNameFragment('GUELPH #1168'), false);
  assert.equal(looksLikeNameFragment('123456789012'), false); // barcode/member
  assert.equal(looksLikeNameFragment('42'), false);          // bare small number
});

test('looksLikeNameFragment treats plain alpha text as a wrap fragment', () => {
  assert.equal(looksLikeNameFragment('FRANKS'), true);
  assert.equal(looksLikeNameFragment('SAUCE'), true);
  assert.equal(looksLikeNameFragment('DEPOSIT'), true);
  assert.equal(looksLikeNameFragment('VL/1945087'), true);
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

test('Costco R1 — single-tender (2025-12-13, $947.04)', { skip: skipUnless('costco-till-2025-12-13.pdf') }, async () => {
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
  skip: skipUnless('costco-till-2025-12-26.pdf'),
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

test('Costco R3 — four `qty @ unitPrice` lines across 3 pages (2026-02-13, $582.64)', {
  skip: skipUnless('costco-till-2026-02-13.pdf'),
}, async () => {
  const lines = await loadLines('costco-till-2026-02-13.pdf');
  const { extracted, warnings } = costcoTillReceiptParser.parse(lines, { defaultCurrency: 'CAD' });

  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);
  assert.equal(extracted.orderDate, '2026-02-13');
  assert.equal(extracted.orderId, '1168-8-492-36-20260213-2013');
  assert.equal(extracted.subtotal, 531.31);
  assert.equal(extracted.total, 582.64);

  // No phantom items from the four `2 @ ...` lines.
  assert.equal(extracted.items.filter((it) => it.title === '@').length, 0);

  const sum = extracted.items.reduce((a, it) => a + (it.totalPrice ?? 0), 0);
  assert.ok(Math.abs(sum - 531.31) < 0.01, `items sum ${sum.toFixed(2)} != 531.31`);

  // Each multi-quantity item carries its real breakdown rather than qty 1.
  const expectations: [string, number, number, number][] = [
    ['85', 2, 17.99, 35.98],      // DIET COKE
    ['4788', 2, 5.79, 11.58],     // LAC FREE 2%
    ['378868', 2, 15.99, 31.98],  // CAMPO VIEJO
    ['2519', 2, 0.2, 0.4],        // bottle deposit, name wraps around its row
  ];
  for (const [id, qty, unit, total] of expectations) {
    const it = extracted.items.find((x) => x.vendorItemId === id);
    assert.ok(it, `item ${id} not found`);
    assert.equal(it.quantity, qty, `${id} quantity`);
    assert.equal(it.unitPrice, unit, `${id} unitPrice`);
    assert.equal(it.totalPrice, total, `${id} totalPrice`);
  }
});

// ─── Synthetic twins of R1/R2/R3 (made-up receipts, always run) ──────────────

const parseSynthetic = (pages: SynthPage[]) =>
  costcoTillReceiptParser.parse(synthPdfLines(pages), { defaultCurrency: 'CAD' });
const itemsSum = (items: { totalPrice: number | null }[]) => items.reduce((a, it) => a + (it.totalPrice ?? 0), 0);

test('Costco synthetic R1 — single-tender, TPD discounts, wrapped name', () => {
  const { extracted, warnings } = parseSynthetic(SYN_COSTCO_R1);

  assert.deepEqual(warnings, []);
  assert.equal(extracted.vendor, 'costco');
  assert.equal(extracted.vendorName, 'Costco ANYTOWN #0999');
  assert.equal(extracted.orderDate, '2024-05-04');
  assert.equal(extracted.orderId, '0999-11-303-23-20240504-1107');
  assert.equal(extracted.subtotal, 493.44);
  assert.equal(extracted.tax, 54.2);
  assert.equal(extracted.total, 547.64);
  assert.equal(extracted.currency, 'CAD');
  assert.equal(extracted.paymentLast4, '9001');
  assert.deepEqual(extracted.tenders, [{ paymentLast4: '9001', network: 'costco-mastercard', amount: 547.64 }]);

  // 6 catalog items + 2 TPD discount lines = 8 line items
  assert.equal(extracted.items.length, 8);

  const widget = extracted.items.find((it) => it.vendorItemId === '1000001');
  assert.ok(widget, 'SAMPLE WIDGET not found');
  assert.equal(widget.title, 'SAMPLE WIDGET');
  assert.equal(widget.totalPrice, 29.99);
  assert.equal(widget.taxable, true);

  // Wrap case: HOT / <id + price> / SAUCE
  const sauce = extracted.items.find((it) => it.vendorItemId === '2000003');
  assert.ok(sauce, 'HOT SAUCE item not found');
  assert.equal(sauce.title, 'HOT SAUCE');
  assert.equal(sauce.totalPrice, 9.99);
  assert.equal(sauce.taxable, false);

  // TPD discount (trailing minus)
  const tpd = extracted.items.find((it) => it.vendorItemId === '1000005');
  assert.ok(tpd, 'TPD/1000004 discount not found');
  assert.equal(tpd.title, 'TPD/1000004');
  assert.equal(tpd.totalPrice, -100);

  assert.ok(Math.abs(itemsSum(extracted.items) - 493.44) < 0.01);
});

test('Costco synthetic R2 — split tender over a page break, deposit wrap, comma-thousands', () => {
  const { extracted, warnings } = parseSynthetic(SYN_COSTCO_R2);

  assert.deepEqual(warnings, []);
  assert.equal(extracted.orderDate, '2024-06-15');
  assert.equal(extracted.orderId, '0999-7-285-17-20240615-1546');
  assert.equal(extracted.subtotal, 1763.86);
  assert.equal(extracted.tax, 224.36);
  assert.equal(extracted.total, 1988.22);

  // Split tender: the Costco MC tender has no printed mask, so no last4.
  assert.deepEqual(extracted.tenders, [
    { paymentLast4: '4242', network: 'mastercard', amount: 1200 },
    { paymentLast4: null, network: 'costco-mastercard', amount: 788.22 },
  ]);
  // Multi-tender → top-level paymentLast4 is null (matcher must use tenders[]).
  assert.equal(extracted.paymentLast4, null);

  assert.ok(Math.abs(itemsSum(extracted.items) - 1763.86) < 0.01);

  const deposit = extracted.items.find((it) => it.vendorItemId === '4002');
  assert.ok(deposit, 'bottle deposit item not found');
  assert.equal(deposit.title, 'DEPOSIT VL/3000004');
  assert.equal(deposit.totalPrice, 2.4);
  assert.equal(deposit.taxable, null); // no Y/N flag on deposit lines

  const tv = extracted.items.find((it) => it.vendorItemId === '3000001');
  assert.ok(tv, 'SAMPLE TV 65IN not found');
  assert.equal(tv.title, 'SAMPLE TV 65IN');
  assert.equal(tv.totalPrice, 1899.99);
});

test('Costco synthetic R3 — four `qty @ unitPrice` lines across 3 pages', () => {
  const { extracted, warnings } = parseSynthetic(SYN_COSTCO_R3);

  assert.deepEqual(warnings, []);
  assert.equal(extracted.orderDate, '2024-02-13');
  assert.equal(extracted.orderId, '0999-8-492-36-20240213-2013');
  assert.equal(extracted.subtotal, 81.13);
  assert.equal(extracted.total, 89.49);

  assert.equal(extracted.items.filter((it) => it.title === '@').length, 0);
  assert.equal(extracted.items.length, 5);
  assert.ok(Math.abs(itemsSum(extracted.items) - 81.13) < 0.01);

  const expectations: [string, number, number, number][] = [
    ['5000001', 2, 15.99, 31.98],
    ['5000002', 2, 6.49, 12.98],
    ['5000004', 2, 13.99, 27.98], // qty line ends page 1, its item opens page 2
    ['4003', 2, 0.1, 0.2],        // bottle deposit, name wraps around its row
  ];
  for (const [id, qty, unit, total] of expectations) {
    const it = extracted.items.find((x) => x.vendorItemId === id);
    assert.ok(it, `item ${id} not found`);
    assert.equal(it.quantity, qty, `${id} quantity`);
    assert.equal(it.unitPrice, unit, `${id} unitPrice`);
    assert.equal(it.totalPrice, total, `${id} totalPrice`);
  }
  // A plain row with no qty line keeps quantity 1.
  const bread = extracted.items.find((x) => x.vendorItemId === '5000003');
  assert.equal(bread?.quantity, 1);
});

// Synthetic receipt — no real purchase data, so it is committable to a public
// repo and always runs in CI (unlike the fixture-gated R1/R2 tests above).
// Line shapes are taken from four real Costco Guelph receipts: a `<qty> @ <unit>`
// continuation line, a trailing-minus TPD discount, a name that wraps around its
// numeric row, a comma-thousands amount, and a split tender across two pages.
function syntheticLines(): { page: number; y: number; text: string }[] {
  const p1: string[] = [
    'GUELPH #1168',
    '1111111 WIDGET A              29.99 Y',
    '2 @ 17.99',
    '85              GIZMO 2PK              35.98 Y',
    '2222222 TPD/1111111              5.00-',
    '3333333 BIG THING              1,234.56 Y',
    '2 @ 0.20',
    'DEPOSIT',
    '4444                                          0.40',
    'VL/3333333',
    'SUBTOTAL              1,295.93',
    'TAX              168.47',
    '****              TOTAL              1,464.40',
    'XXXXXXXXXXXXX3812              CHIP read',
    'APPROVED -PURCHASE',
    'AMOUNT: $1,464.40',
    'MASTER CARD              1,000.00',
    'COSTCO MASTERCARD              464.40',
    'CHANGE              0',
    'TOTAL NUMBER OF ITEMS SOLD = 5',
    '05/04/2026 11:07              1168 7 285 17',
  ];
  const p2: string[] = ['whse: 1168              Trm: 7', ' Items Sold: 5'];
  return [
    ...p1.map((text, i) => ({ page: 1, y: 700 - i * 19.2, text })),
    ...p2.map((text, i) => ({ page: 2, y: 700 - i * 19.2, text })),
  ];
}

test('a `<qty> @ <unitPrice>` line is folded into the following item, not emitted as an item', () => {
  const { extracted, warnings } = costcoTillReceiptParser.parse(syntheticLines(), {
    defaultCurrency: 'CAD',
  });

  // No phantom `@` item.
  assert.equal(
    extracted.items.filter((it) => it.title === '@').length,
    0,
    `phantom @ items: ${JSON.stringify(extracted.items.filter((it) => it.title === '@'))}`,
  );

  // 4 catalog rows + 1 TPD discount row. The two `@` lines are not items.
  assert.equal(extracted.items.length, 5, `items: ${extracted.items.map((i) => i.title).join(', ')}`);

  // Items reconcile against SUBTOTAL, so no warning.
  const sum = extracted.items.reduce((a, it) => a + (it.totalPrice ?? 0), 0);
  assert.ok(Math.abs(sum - 1295.93) < 0.01, `items sum ${sum.toFixed(2)} != 1295.93`);
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);
});

test('a `<qty> @ <unitPrice>` line sets quantity and unitPrice on the item it precedes', () => {
  const { extracted } = costcoTillReceiptParser.parse(syntheticLines(), { defaultCurrency: 'CAD' });

  const gizmo = extracted.items.find((it) => it.vendorItemId === '85');
  assert.ok(gizmo, 'GIZMO 2PK not found');
  assert.equal(gizmo.title, 'GIZMO 2PK');
  assert.equal(gizmo.quantity, 2);
  assert.equal(gizmo.unitPrice, 17.99);
  assert.equal(gizmo.totalPrice, 35.98);
});

test('a `<qty> @ <unitPrice>` line carries across a wrapped name fragment to its item', () => {
  // Real shape: `2 @ 0.20` / `DEPOSIT` / `4444  0.40` / `VL/3333333`.
  // The qty line is not adjacent to the numeric row it belongs to.
  const { extracted } = costcoTillReceiptParser.parse(syntheticLines(), { defaultCurrency: 'CAD' });

  const deposit = extracted.items.find((it) => it.vendorItemId === '4444');
  assert.ok(deposit, 'deposit item not found');
  assert.equal(deposit.title, 'DEPOSIT VL/3333333');
  assert.equal(deposit.quantity, 2);
  assert.equal(deposit.unitPrice, 0.2);
  assert.equal(deposit.totalPrice, 0.4);
});
