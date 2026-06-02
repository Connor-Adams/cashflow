import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from '../src/import/pdf/types';
import { wealthsimpleCreditCardParser, parseWsCreditCardHeader } from '../src/import/pdf/wealthsimpleCreditCard';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

test('sniff requires Wealthsimple + credit-card markers', () => {
  assert.equal(
    wealthsimpleCreditCardParser.sniff([mk('Credit card statement'), mk('Wealthsimple Payments Inc.')]),
    true,
  );
  assert.equal(wealthsimpleCreditCardParser.sniff([mk('Credit card statement')]), false);
  assert.equal(wealthsimpleCreditCardParser.sniff([mk('CIBC Costco Mastercard')]), false);
});

test('header extracts period, statement date, last-4', () => {
  const h = parseWsCreditCardHeader([
    mk('Credit card statement'),
    mk(' Wealthsimple    Apr 15 — May 14, 2026'),
    mk('4126 50** **** 3338'),
    mk(' Statement date   May 15, 2026          Minimum payment   $10.00'),
  ]);
  assert.equal(h.accountType, 'credit_card');
  assert.equal(h.productLabel, 'Wealthsimple Credit Card');
  assert.equal(h.accountSuffix, '3338');
  assert.equal(h.periodStart, '2026-04-15');
  assert.equal(h.periodEnd, '2026-05-14');
});

test('parse extracts purchases (negative) and payments (positive)', () => {
  const lines: PdfLine[] = [
    mk('Credit card statement'),
    mk(' Wealthsimple    Apr 15 — May 14, 2026'),
    mk('4126 50** **** 3338'),
    mk(' Statement date   May 15, 2026'),
    mk(' TRANS. DATE   POSTED DATE   TYPE   DETAILS   AMOUNT ($CAD)', 2),
    mk(' Apr 16   Apr 17   Purchase   A&W #4655   $10.49', 2),
    mk('May 6   May 6   Payment   From chequing account   –$4,404.43', 2),
    mk("May 13   May 14   Purchase   LONGO'S GUELPH   $1.46", 2),
  ];
  const result = wealthsimpleCreditCardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.transactions.length, 3);

  const aw = result.transactions.find((t) => t.merchantRaw.includes('A&W'))!;
  assert.equal(aw.amount, -10.49);          // purchase → charge → negative
  assert.equal(aw.date, '2026-04-16');       // TRANS. DATE, year inferred
  assert.equal(aw.currency, 'CAD');

  const pay = result.transactions.find((t) => t.merchantRaw.includes('chequing'))!;
  assert.equal(pay.amount, 4404.43);         // payment → credit → positive
  assert.equal(pay.date, '2026-05-06');
});

test('parse infers prior year across the Jan boundary', () => {
  const lines: PdfLine[] = [
    mk('Credit card statement'),
    mk('Wealthsimple Dec 15 — Jan 14, 2026'),
    mk('4126 50** **** 3338'),
    mk('Statement date Jan 15, 2026'),
    mk('TRANS. DATE   POSTED DATE   TYPE   DETAILS   AMOUNT ($CAD)', 2),
    mk('Dec 20   Dec 21   Purchase   IKEA   $50.00', 2),
    mk('Jan 3   Jan 4   Purchase   ZEHRS   $20.00', 2),
  ];
  const result = wealthsimpleCreditCardParser.parse(lines, { defaultCurrency: 'CAD' });
  const ikea = result.transactions.find((t) => t.merchantRaw.includes('IKEA'))!;
  assert.equal(ikea.date, '2025-12-20');
  const zehrs = result.transactions.find((t) => t.merchantRaw.includes('ZEHRS'))!;
  assert.equal(zehrs.date, '2026-01-03');
});

test('parse warns when purchases sum disagrees with Account summary Purchases total', () => {
  const lines: PdfLine[] = [
    mk('Credit card statement'),
    mk(' Wealthsimple    Apr 15 — May 14, 2026'),
    mk('4126 50** **** 3338'),
    mk(' Statement date   May 15, 2026'),
    mk(' - Payments   $4,404.43          + Purchases   $1,474.04'),
    mk(' TRANS. DATE   POSTED DATE   TYPE   DETAILS   AMOUNT ($CAD)', 2),
    mk(' Apr 16   Apr 17   Purchase   A&W #4655   $10.49', 2),
  ];
  const result = wealthsimpleCreditCardParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.ok(result.warnings.some((w) => /Purchases.*mismatch/i.test(w)));
});

test('reconciliation excludes Monthly fee from the Purchases total', () => {
  const lines: PdfLine[] = [
    mk('Credit card statement'),
    mk('Wealthsimple Apr 15 — May 14, 2026'),
    mk('4126 50** **** 3338'),
    mk('Statement date May 15, 2026'),
    mk('+ Purchases $100.00'),
    mk('TRANS. DATE   POSTED DATE   TYPE   DETAILS   AMOUNT ($CAD)', 2),
    mk('Apr 16   Apr 17   Purchase   A&W #4655   $100.00', 2),
    mk('Apr 30   Apr 30   Fee   Monthly fee   $10.00', 2),
  ];
  const r = wealthsimpleCreditCardParser.parse(lines, { defaultCurrency: 'CAD' });
  // The $10 fee must NOT count toward the Purchases reconciliation.
  assert.equal(r.warnings.filter((w) => /Purchases.*mismatch/i.test(w)).length, 0);
  // Fee is still captured as a negative transaction.
  assert.ok(r.transactions.some((t) => /Monthly fee/i.test(t.merchantRaw) && t.amount === -10));
});

test('reconciliation tolerates a space artifact in the Purchases total', () => {
  const lines: PdfLine[] = [
    mk('Credit card statement'),
    mk('Wealthsimple Apr 15 — May 14, 2026'),
    mk('4126 50** **** 3338'),
    mk('Statement date May 15, 2026'),
    mk('+ Purchases $5,1 13.78'),
    mk('TRANS. DATE   POSTED DATE   TYPE   DETAILS   AMOUNT ($CAD)', 2),
    mk('Apr 16   Apr 17   Purchase   IKEA   $5,113.78', 2),
  ];
  const r = wealthsimpleCreditCardParser.parse(lines, { defaultCurrency: 'CAD' });
  // Total parses despite the embedded space; sums match → no warning.
  assert.equal(r.warnings.filter((w) => /Purchases.*mismatch/i.test(w)).length, 0);
});
