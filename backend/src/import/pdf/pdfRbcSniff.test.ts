import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from './types';
import { rbcPersonalBankingParser } from './rbcPersonalBanking';
import { rbcVisaParser } from './rbcVisa';
import { rbcCreditLineParser } from './rbcCreditLine';
import { rbcInvestmentParser } from './rbcInvestment';

function mkLine(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

test('rbcPersonalBankingParser sniff matches "personal banking" title', () => {
  assert.equal(
    rbcPersonalBankingParser.sniff([mkLine('Your RBC personal banking account statement')]),
    true,
  );
});

test('rbcPersonalBankingParser sniff matches "personal savings" title', () => {
  assert.equal(
    rbcPersonalBankingParser.sniff([mkLine('Your RBC personal savings account statement')]),
    true,
  );
});

test('rbcPersonalBankingParser sniff rejects unrelated lines', () => {
  assert.equal(
    rbcPersonalBankingParser.sniff([mkLine('CIBC Costco Mastercard')]),
    false,
  );
});

test('rbcVisaParser sniff matches Signature RBC Rewards Visa', () => {
  assert.equal(
    rbcVisaParser.sniff([mkLine('Signature® RBC Rewards® Visa‡')]),
    true,
  );
});

test('rbcVisaParser sniff matches RBC Avion Visa', () => {
  assert.equal(rbcVisaParser.sniff([mkLine('RBC Avion Visa')]), true);
});

test('rbcCreditLineParser sniff matches Royal Credit Line title', () => {
  assert.equal(
    rbcCreditLineParser.sniff([mkLine('Your Royal Credit Line® Statement')]),
    true,
  );
});

test('rbcInvestmentParser sniff requires both investment-statement title and TFSA/RDSP marker', () => {
  // Title alone is not enough.
  assert.equal(
    rbcInvestmentParser.sniff([mkLine('Your investment statement')]),
    false,
  );
  // Title + TFSA marker → match.
  assert.equal(
    rbcInvestmentParser.sniff([
      mkLine('Your investment statement'),
      mkLine('Tax-Free Savings Account'),
    ]),
    true,
  );
  // Title + RDSP marker → match.
  assert.equal(
    rbcInvestmentParser.sniff([
      mkLine('Your investment statement'),
      mkLine('Registered Disability Savings Plan'),
    ]),
    true,
  );
});

test('built-in registry includes all 4 RBC parsers', async () => {
  const mod = await import('./registry');
  mod.clearPdfParsersForTest();
  mod.registerBuiltInPdfParsers();

  const personalBankingHit = mod.findPdfParser([
    mkLine('Your RBC personal banking account statement'),
  ]);
  assert.equal(personalBankingHit?.id, 'rbc_personal_banking');

  const visaHit = mod.findPdfParser([mkLine('Signature® RBC Rewards® Visa‡')]);
  assert.equal(visaHit?.id, 'rbc_visa');

  const creditLineHit = mod.findPdfParser([mkLine('Your Royal Credit Line® Statement')]);
  assert.equal(creditLineHit?.id, 'rbc_credit_line');

  const investmentHit = mod.findPdfParser([
    mkLine('Your investment statement'),
    mkLine('Registered Disability Savings Plan'),
  ]);
  assert.equal(investmentHit?.id, 'rbc_investment');
});
