/**
 * Unit tests for the RBC investment (TFSA / RDSP) PDF parser body sections.
 *
 * pdfjs v5 glues an entire transaction row into a SINGLE positioned span (see
 * the parseInvestmentDetails comment and rbcPersonalBanking.ts) — so the
 * savings-deposit parser must extract money tokens from the LINE TEXT, not
 * from per-column `items` spans, or real TFSA cash rows vanish silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine, PdfTextSpan } from './types';
import { rbcInvestmentParser } from './rbcInvestment';

/** A line whose entire row of text is ONE glued span (pdfjs v5 behavior). */
function mkGlued(text: string, page = 1, y = 0, x = 47): PdfLine {
  const span: PdfTextSpan = { x, width: text.length * 5, str: text.trim() };
  return { page, y, text, items: [span] };
}

function tfsaHeader(): PdfLine[] {
  return [
    mkGlued('Your investment statement', 1, 780),
    mkGlued('January 1, 2025 to December 31, 2025', 1, 760),
    mkGlued('Your account number  435516430', 1, 700),
    mkGlued('Tax-Free Savings Account', 1, 680),
  ];
}

test('sniff — matches TFSA investment statement', () => {
  assert.equal(rbcInvestmentParser.sniff(tfsaHeader()), true);
});

test('savings deposit row glued into a single span is parsed, not silently dropped', () => {
  const lines: PdfLine[] = [
    ...tfsaHeader(),
    mkGlued('Your savings deposit activity', 2, 600),
    mkGlued('RBC Savings Deposit', 2, 588),
    mkGlued('Opening Balance   0.00', 2, 576),
    mkGlued('Dec 23 2025   Contribution   1,000.00   1,000.00', 2, 564),
    mkGlued('Closing Balance   1,000.00', 2, 552),
    mkGlued('Information about your account', 2, 500),
  ];
  const out = rbcInvestmentParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(
    out.transactions.length,
    1,
    `expected 1 savings txn, got ${JSON.stringify(out.transactions)}`,
  );
  const t = out.transactions[0];
  assert.equal(t.date, '2025-12-23');
  assert.equal(t.merchantRaw, 'Contribution');
  assert.equal(t.amount, 1000);
  assert.equal(t.currency, 'CAD');
});

test('savings deposit section with only opening/closing balances emits no transactions', () => {
  const lines: PdfLine[] = [
    ...tfsaHeader(),
    mkGlued('Your savings deposit activity', 2, 600),
    mkGlued('RBC Savings Deposit', 2, 588),
    mkGlued('Opening Balance   1,000.00', 2, 576),
    mkGlued('Closing Balance   1,000.00', 2, 552),
    mkGlued('Information about your account', 2, 500),
  ];
  const out = rbcInvestmentParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.deepEqual(out.transactions, []);
});
