import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from './types';
import { parseQuestradeHeader, questradeParser } from './questrade';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

test('questradeParser sniff requires Questrade + order-execution markers', () => {
  assert.equal(questradeParser.sniff([mk('QUESTRADE')]), false);
  assert.equal(
    questradeParser.sniff([mk('QUESTRADE'), mk('Order execution only account')]),
    true,
  );
  assert.equal(
    questradeParser.sniff([mk('Other Bank'), mk('Order execution only account')]),
    false,
  );
});

test('parseQuestradeHeader extracts Margin account', () => {
  const lines: PdfLine[] = [
    mk('QUESTRADE'),
    mk('Order execution only account'),
    mk('Account #: 28852545   Current month: October 31, 2023'),
    mk('Type: Individual Margin   Account opened: September 25, 2023'),
    mk('Currency: CAD/USD   Dealer: Questrade, Inc.'),
  ];
  const h = parseQuestradeHeader(lines);
  assert.equal(h.accountSuffix, '2545');
  assert.equal(h.productLabel, 'Individual Margin');
  assert.equal(h.accountType, 'investment');
  assert.equal(h.periodStart, '2023-10-01');
  assert.equal(h.periodEnd, '2023-10-31');
});

test('parseQuestradeHeader detects FHSA across wrapped Type label', () => {
  const lines: PdfLine[] = [
    mk('QUESTRADE'),
    mk('Order execution only account'),
    mk('Account #: 53064109   Current month: December 29, 2023'),
    mk('Type: Individual Tax-Free First Home Savings'),
    mk('ON L6L 4G5   Account (FHSA)   Account opened: September 25, 2023'),
  ];
  const h = parseQuestradeHeader(lines);
  assert.equal(h.accountSuffix, '4109');
  assert.equal(h.productLabel, 'Individual FHSA');
  assert.equal(h.periodEnd, '2023-12-29');
  assert.equal(h.periodStart, '2023-12-01');
});

test('parseQuestradeHeader throws when account number missing', () => {
  assert.throws(
    () =>
      parseQuestradeHeader([
        mk('QUESTRADE'),
        mk('Order execution only account'),
        mk('Current month: October 31, 2023'),
      ]),
    /account number/,
  );
});

test('built-in registry includes questrade and matches on sniff', async () => {
  const mod = await import('./registry');
  mod.clearPdfParsersForTest();
  mod.registerBuiltInPdfParsers();
  const hit = mod.findPdfParser([
    mk('QUESTRADE'),
    mk('Order execution only account'),
  ]);
  assert.equal(hit?.id, 'questrade');
});

test('parse handles a USD stock holding (Margin AMD)', () => {
  // Real-text reproduction of the Sep statement's investment-details section.
  const lines: PdfLine[] = [
    mk('QUESTRADE'),
    mk('Order execution only account'),
    mk('Account #: 28852545   Current month: October 31, 2023'),
    mk('Type: Individual Margin'),
    mk('Stocks owned', 9, 521.7),
    mk('Securities held in USD', 9, 391.1),
    mk(
      'AMD   ADVANCED MICRO DEVICES INC COM   BK   2.00   2.00   105.60   211.19   98.50   197.00   -14.19   -6.72   100.00',
      9,
      376.7,
    ),
    mk('04. ACTIVITY DETAILS', 9, 45.9),
  ];
  const result = questradeParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.holdings?.length, 1);
  const h = result.holdings![0];
  assert.equal(h.security.symbol, 'AMD');
  assert.equal(h.security.name, 'ADVANCED MICRO DEVICES INC COM');
  assert.equal(h.security.assetType, 'stock');
  assert.equal(h.security.currency, 'USD');
  assert.equal(h.quantity, 2);
  assert.equal(h.price, 98.5);
  assert.equal(h.marketValue, 197);
  assert.equal(h.costBasis, 211.19);
  assert.equal(h.unrealizedGainLoss, -14.19);
});

test('parse ignores right-side glossary text appended to holding rows', () => {
  const lines: PdfLine[] = [
    mk('QUESTRADE'),
    mk('Order execution only account'),
    mk('Account #: 53064109   Current month: December 29, 2023'),
    mk('Type: Individual Tax-Free First Home Savings'),
    mk('Exchange-traded funds (ETFs)', 11, 520.2),
    mk('Securities held in CAD', 11, 400.1),
    mk(
      'VEQT   VANGUARD ALL-EQUITY ETF   BK   195.00   195.00   34.84   6,793.69   36.74   7,164.30   370.61   5.46   85.60   decimals.',
      11,
      350.7,
    ),
    mk('04. ACTIVITY DETAILS', 11, 45.0),
  ];
  const result = questradeParser.parse(lines, { defaultCurrency: 'CAD' });
  assert.equal(result.holdings?.length, 1);
  const h = result.holdings![0];
  assert.equal(h.security.symbol, 'VEQT');
  assert.equal(h.security.name, 'VANGUARD ALL-EQUITY ETF');
  assert.equal(h.security.assetType, 'etf');
  assert.equal(h.security.currency, 'CAD');
  assert.equal(h.quantity, 195);
});

test('parse classifies Buy / Sell / Interest / Transfer activities', () => {
  const lines: PdfLine[] = [
    mk('QUESTRADE'),
    mk('Order execution only account'),
    mk('Account #: 28852545   Current month: November 30, 2023'),
    mk('Type: Individual Margin'),
    mk('Trans Date.  Settle Date.  Activity type  Symbol  Description', 12, 393.4),
    mk('ADVANCED MICRO DEVICES INC COM WE', 12, 356.4),
    mk(
      '11-01-2023   11-03-2023   Sell   AMD       2   -   -   -   -   106.850   213.70   (4.96)   208.74',
      12,
      353.1,
    ),
    mk('ACTED AS AGENT', 12, 349.7),
    mk('DEREGISTRATION FROM ACCOUNT 530-64109', 12, 338.2),
    mk(
      '11-07-2023   11-07-2023   WDR    -   -   -   -   2,025.00   -   -   -   -',
      12,
      334.8,
    ),
    mk('-10', 12, 331.5),
    mk('INT FR 10/16 THRU11/15@13   % BAL   3', 12, 320.0),
    mk(
      '11-16-2023   11-16-2023   -   -   -   -   -   -   -   -   (1.38)',
      12,
      316.6,
    ),
    mk('AVBAL   124', 12, 313.2),
    mk(' VANGUARD ALL-EQUITY ETF PORTFOLIO', 12, 302.1),
    mk(
      '11-21-2023   11-23-2023   Buy   .VEQT         ETF UNIT WE ACTED AS AGENT AVG PRICE -           60   36.350   (2,181.00)   (0.21)   (2,181.21)   -   -   -   -',
      12,
      295.4,
    ),
    mk('ASK US FOR DETAILS', 12, 288.6),
  ];
  const result = questradeParser.parse(lines, { defaultCurrency: 'CAD' });
  const acts = result.investmentActivities!;
  assert.equal(acts.length, 4);

  const sell = acts.find((a) => a.activityType === 'sell');
  assert.ok(sell);
  assert.equal(sell.security?.symbol, 'AMD');
  assert.equal(sell.currency, 'USD');
  assert.equal(sell.amount, 208.74);
  assert.equal(sell.quantity, 2);
  assert.equal(sell.tradeDate, '2023-11-01');
  assert.equal(sell.settlementDate, '2023-11-03');

  const transfer = acts.find((a) => a.activityType === 'transfer');
  assert.ok(transfer);
  assert.equal(transfer.currency, 'CAD');
  assert.equal(transfer.amount, 2025);
  assert.match(transfer.description, /DEREGISTRATION/);

  const interest = acts.find((a) => a.activityType === 'interest');
  assert.ok(interest);
  assert.equal(interest.amount, -1.38);
  assert.equal(interest.currency, 'USD');

  const buy = acts.find((a) => a.activityType === 'buy');
  assert.ok(buy);
  assert.equal(buy.security?.symbol, 'VEQT');
  assert.equal(buy.currency, 'CAD');
  assert.equal(buy.quantity, 60);
  assert.equal(buy.price, 36.35);
  assert.equal(buy.amount, -2181.21);
  assert.equal(buy.fees, -0.21);

  // Transfer also mirrors into cash-side transactions
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, 2025);
  assert.equal(result.transactions[0].currency, 'CAD');
});

test('parse handles FHSA Contribution as cash_movement', () => {
  const lines: PdfLine[] = [
    mk('QUESTRADE'),
    mk('Order execution only account'),
    mk('Account #: 53064109   Current month: November 30, 2023'),
    mk('Type: Individual Tax-Free First Home Savings'),
    mk('Trans Date.  Settle Date.  Activity type  Symbol  Description', 13, 393.4),
    mk(
      '11-03-2023   11-03-2023   Contribution   FHSA CONTRIBUTION   -   -   -   -   7,000.00   -   -   -   -',
      13,
      292.3,
    ),
  ];
  const result = questradeParser.parse(lines, { defaultCurrency: 'CAD' });
  const acts = result.investmentActivities!;
  assert.equal(acts.length, 1);
  assert.equal(acts[0].activityType, 'cash_movement');
  assert.equal(acts[0].amount, 7000);
  assert.equal(acts[0].currency, 'CAD');
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, 7000);
});
