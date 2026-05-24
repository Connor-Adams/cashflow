import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from '../src/import/pdf/types';
import { parseRbcPersonalBankingHeader } from '../src/import/pdf/rbcPersonalBanking';
import { parseRbcVisaHeader } from '../src/import/pdf/rbcVisa';
import { parseRbcCreditLineHeader } from '../src/import/pdf/rbcCreditLine';
import { parseRbcInvestmentHeader } from '../src/import/pdf/rbcInvestment';

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

test('parseRbcInvestmentHeader handles RDSP', () => {
  const lines: PdfLine[] = [
    mk('Your investment statement'),
    mk('October 1, 2025 to December 31, 2025'),
    mk('Royal Mutual Funds Inc.'),
    mk('Registered Disability Savings Plan'),
    mk('Your account number  468184346'),
  ];
  const header = parseRbcInvestmentHeader(lines);
  assert.equal(header.accountSuffix, '4346');
  assert.equal(header.productLabel, 'Registered Disability Savings Plan');
  assert.equal(header.accountType, 'investment');
  assert.equal(header.periodStart, '2025-10-01');
  assert.equal(header.periodEnd, '2025-12-31');
});
