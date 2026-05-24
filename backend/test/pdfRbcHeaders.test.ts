import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from '../src/import/pdf/types';
import { parseRbcPersonalBankingHeader } from '../src/import/pdf/rbcPersonalBanking';
import { parseRbcVisaHeader } from '../src/import/pdf/rbcVisa';
import { parseRbcCreditLineHeader } from '../src/import/pdf/rbcCreditLine';
import { parseRbcInvestmentHeader, rbcInvestmentParser } from '../src/import/pdf/rbcInvestment';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

test('parseRbcPersonalBankingHeader extracts suffix, period, product', () => {
  const lines: PdfLine[] = [
    mk('Your RBC personal banking account statement'),
    mk('From November 3, 2025 to December 2, 2025'),
    mk('Your account number: 02022-5016985'),
    mk('RBC Day to Day Banking™ 02022-5016985'),
  ];
  const header = parseRbcPersonalBankingHeader(lines);
  assert.equal(header.accountSuffix, '6985');
  assert.equal(header.productLabel, 'RBC Day to Day Banking');
  assert.equal(header.accountType, 'checking');
  assert.equal(header.periodStart, '2025-11-03');
  assert.equal(header.periodEnd, '2025-12-02');
});

test('parseRbcPersonalBankingHeader maps eSavings product to savings type', () => {
  const lines: PdfLine[] = [
    mk('Your RBC personal savings account statement'),
    mk('From November 3, 2025 to December 2, 2025'),
    mk('Your account number: 02022-5084660'),
    mk('RBC High Interest eSavings™ 02022-5084660'),
  ];
  const header = parseRbcPersonalBankingHeader(lines);
  assert.equal(header.accountSuffix, '4660');
  assert.equal(header.productLabel, 'RBC High Interest eSavings');
  assert.equal(header.accountType, 'savings');
});

test('parseRbcPersonalBankingHeader maps NOMI Find & Save to savings', () => {
  const lines: PdfLine[] = [
    mk('Your RBC personal savings account statement'),
    mk('From November 3, 2025 to December 2, 2025'),
    mk('Your account number: 02022-5030358'),
    mk('Find & Save™ 02022-5030358'),
  ];
  const header = parseRbcPersonalBankingHeader(lines);
  assert.equal(header.accountSuffix, '0358');
  assert.equal(header.productLabel, 'Find & Save');
  assert.equal(header.accountType, 'savings');
});

test('parseRbcVisaHeader extracts last 4 + product label + period', () => {
  const lines: PdfLine[] = [
    mk('Signature® RBC Rewards® Visa‡'),
    mk('CONNOR ADAMS 4510 15** **** 5234'),
    mk('STATEMENT FROM NOV 08 TO DEC 8, 2025'),
  ];
  const header = parseRbcVisaHeader(lines);
  assert.equal(header.accountSuffix, '5234');
  assert.equal(header.productLabel, 'Signature RBC Rewards Visa');
  assert.equal(header.accountType, 'credit_card');
  assert.equal(header.periodStart, '2025-11-08');
  assert.equal(header.periodEnd, '2025-12-08');
});

test('parseRbcVisaHeader handles year boundary (Dec → Jan)', () => {
  const lines: PdfLine[] = [
    mk('Signature® RBC Rewards® Visa‡'),
    mk('CONNOR ADAMS 4510 15** **** 5234'),
    mk('STATEMENT FROM DEC 15 TO JAN 14, 2026'),
  ];
  const header = parseRbcVisaHeader(lines);
  assert.equal(header.periodStart, '2025-12-15');
  assert.equal(header.periodEnd, '2026-01-14');
});

test('parseRbcCreditLineHeader extracts suffix, period, product=loan', () => {
  const lines: PdfLine[] = [
    mk('Your Royal Credit Line® Statement'),
    mk('From November 4, 2025 to December 3, 2025'),
    mk('Your loan account number: 73772650-001'),
  ];
  const header = parseRbcCreditLineHeader(lines);
  assert.equal(header.accountSuffix, '0001');
  assert.equal(header.productLabel, 'Royal Credit Line');
  assert.equal(header.accountType, 'loan');
  assert.equal(header.periodStart, '2025-11-04');
  assert.equal(header.periodEnd, '2025-12-03');
});

test('parseRbcInvestmentHeader handles TFSA', () => {
  const lines: PdfLine[] = [
    mk('Your investment statement'),
    mk('January 1, 2025 to December 31, 2025'),
    mk('Royal Bank of Canada'),
    mk('Tax-Free Savings Account'),
    mk('Your account number  435516430'),
  ];
  const header = parseRbcInvestmentHeader(lines);
  assert.equal(header.accountSuffix, '6430');
  assert.equal(header.productLabel, 'Tax-Free Savings Account');
  assert.equal(header.accountType, 'investment');
  assert.equal(header.periodStart, '2025-01-01');
  assert.equal(header.periodEnd, '2025-12-31');
});

test('rbcInvestmentParser extracts RDSP holdings + activity from split y-bucket rows', () => {
  // Reproduces the real pdfjs output for an RDSP statement: numeric columns
  // sit on the line ABOVE the date+label row (y-gap < Y_TOLERANCE+1), so the
  // parser must cache pending numerics and attach them to the next date row.
  const lines: PdfLine[] = [
    mk(' October 1, 2025 to December 31, 2025'),
    mk(' Registered Disability Savings Plan            Your account number   Your branch'),
    mk(' 468184346   1005 SPEERS RD'),
    mk(' Your investment statement'),
    // Holdings section
    mk(' Your investment details with Royal Mutual Funds Inc.'),
    mk(' Your unit      Units you own     Unit price on             Value on       Book Cost'),
    mk(' Balanced Funds'),
    mk(' RBC Select Growth Portfolio - Sr. A (RBF459)'),
    mk(' 34.4738   2,299.066   42.8452   98,503.94   79,257.45'),
    mk(' Total   $98,503.94   $79,257.45'),
    // Activity section: numerics on the line above each date label
    mk(' Your investment activity with Royal Mutual Funds Inc.'),
    mk(' RBC Select Growth Portfolio - Sr. A (RBF459)'),
    mk('44.2080   2,189.222   96,781.13'),
    mk(' Opening Balance'),
    mk('2,189.222'),
    mk(' Dec 23 2025   Income Record Date Holdings'),
    mk('4,717.78   42.9500   109.844   2,299.066   98,744.88'),
    mk(' Dec 23 2025   Income Reinvested'),
    mk('0.0000   0.000'),
    mk(' ( 2.1550000 per Unit )'),
    mk('42.8452   2,299.066   98,503.94'),
    mk(' Dec 31 2025   Closing Balance'),
  ];
  const res = rbcInvestmentParser.parse(lines, { defaultCurrency: 'CAD' });

  assert.equal(res.header.accountSuffix, '4346');
  assert.equal(res.holdings.length, 1);
  assert.equal(res.holdings[0].security.symbol, 'RBF459');
  assert.equal(res.holdings[0].quantity, 2299.066);
  assert.equal(res.holdings[0].price, 42.8452);
  assert.equal(res.holdings[0].marketValue, 98503.94);
  assert.equal(res.holdings[0].costBasis, 79257.45);

  // Opening/Closing balance and Income Record Date Holdings rows MUST be skipped;
  // only the real "Income Reinvested" activity emits.
  assert.equal(res.investmentActivities.length, 1);
  const act = res.investmentActivities[0];
  assert.equal(act.activityType, 'reinvestment');
  assert.equal(act.tradeDate, '2025-12-23');
  assert.equal(act.amount, 4717.78);
  assert.equal(act.price, 42.95);
  assert.equal(act.quantity, 109.844);
});

test('parseRbcInvestmentHeader handles RDSP with two-line account header', () => {
  // Real RDSP statements split "Your account number" label and the digits
  // across two PDF lines (column layout next to "Your branch").
  const lines: PdfLine[] = [
    mk(' October 1, 2025 to December 31, 2025'),
    mk(' Registered Disability Savings Plan            Your account number   Your branch'),
    mk(' 468184346   1005 SPEERS RD'),
    mk('Royal Mutual Funds Inc.'),
  ];
  const header = parseRbcInvestmentHeader(lines);
  assert.equal(header.accountSuffix, '4346');
  assert.equal(header.productLabel, 'Registered Disability Savings Plan');
  assert.equal(header.accountType, 'investment');
  assert.equal(header.periodStart, '2025-10-01');
  assert.equal(header.periodEnd, '2025-12-31');
});
