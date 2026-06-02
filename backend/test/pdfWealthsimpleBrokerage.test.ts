import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from '../src/import/pdf/types';
import {
  wsPdfCodeToActivity,
  WS_PDF_SKIP_CODES,
} from '../src/import/pdf/wealthsimpleActivityCodes';
import {
  wealthsimpleBrokerageParser,
  parseWsBrokerageHeader,
} from '../src/import/pdf/wealthsimpleBrokerage';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

// ---------------------------------------------------------------------------
// Taxonomy (shared wealthsimpleActivityCodes module)
// ---------------------------------------------------------------------------

test('wsPdfCodeToActivity aligns with TX_TO_ACTIVITY for shared codes', () => {
  assert.equal(wsPdfCodeToActivity('BUY'), 'buy');
  assert.equal(wsPdfCodeToActivity('SELL'), 'sell');
  assert.equal(wsPdfCodeToActivity('DIV'), 'dividend');
  assert.equal(wsPdfCodeToActivity('INT'), 'interest');
  assert.equal(wsPdfCodeToActivity('FPLINT'), 'interest');
  assert.equal(wsPdfCodeToActivity('FEE'), 'fee');
  assert.equal(wsPdfCodeToActivity('CONT'), 'transfer');
  assert.equal(wsPdfCodeToActivity('CRYPTORWD'), 'staking_reward');
});

test('wsPdfCodeToActivity maps cash-movement / transfer codes', () => {
  assert.equal(wsPdfCodeToActivity('DEP'), 'cash_movement');
  assert.equal(wsPdfCodeToActivity('WD'), 'cash_movement');
  assert.equal(wsPdfCodeToActivity('TRFIN'), 'transfer_in');
  assert.equal(wsPdfCodeToActivity('TRFOUT'), 'transfer_out');
  assert.equal(wsPdfCodeToActivity('ROC'), 'return_of_capital');
});

test('zero-cash stock-lending codes are flagged skip, not misclassified', () => {
  assert.ok(WS_PDF_SKIP_CODES.has('LOAN'));
  assert.ok(WS_PDF_SKIP_CODES.has('RECALL'));
  assert.equal(wsPdfCodeToActivity('LOAN'), null);
});

test('unknown code returns null', () => {
  assert.equal(wsPdfCodeToActivity('ZZZ'), null);
});

// ---------------------------------------------------------------------------
// Sniff + header (Task 6)
// ---------------------------------------------------------------------------

test('brokerage sniff requires order-execution + Wealthsimple, not Questrade', () => {
  assert.equal(
    wealthsimpleBrokerageParser.sniff([
      mk('ORDER EXECUTION ONLY ACCOUNT'),
      mk('This statement is being issued to you by Wealthsimple Investments Inc.'),
      mk(' Account No.   Owner   Statement Period'),
    ]),
    true,
  );
  // Questrade also says "order execution only account" — must NOT match it.
  assert.equal(
    wealthsimpleBrokerageParser.sniff([
      mk('QUESTRADE'),
      mk('Order execution only account'),
    ]),
    false,
  );
  // Missing the Wealthsimple marker.
  assert.equal(
    wealthsimpleBrokerageParser.sniff([mk('ORDER EXECUTION ONLY ACCOUNT')]),
    false,
  );
});

test('brokerage parser declares cross-source dedup + ws_holding fingerprint', () => {
  assert.equal(wealthsimpleBrokerageParser.crossSourceDedup, 'fuzzy-window-5d');
  assert.equal(wealthsimpleBrokerageParser.holdingFingerprint, 'ws_holding');
});

test('brokerage header parses account no., period, TFSA label (real fixture line)', () => {
  const h = parseWsBrokerageHeader([
    mk('ORDER EXECUTION ONLY ACCOUNT', 1, 798.8),
    mk(' All figures in $CAD unless otherwise specified', 1, 781.5),
    mk(' Account No.   Owner   Statement Period', 1, 762.2),
    mk(' HQ6LMLTK8CAD   Connor Adams   2025-05-01 - 2025-05-31', 1, 749.6),
    mk(' Tax-Free Savings SDI Cash Account', 1, 699.9),
  ]);
  assert.equal(h.accountSuffix, 'HQ6LMLTK8CAD');
  assert.equal(h.accountType, 'investment');
  assert.equal(h.productLabel, 'Wealthsimple TFSA');
  assert.equal(h.periodStart, '2025-05-01');
  assert.equal(h.periodEnd, '2025-05-31');
  assert.equal(h.accountHolder, 'Connor Adams');
  assert.equal(h.currency, 'CAD');
});

test('brokerage header detects margin label + CAD currency from suffix (real fixture)', () => {
  const h = parseWsBrokerageHeader([
    mk('ORDER EXECUTION ONLY ACCOUNT', 1, 798.8),
    mk(' Account No.   Owner   Statement Period', 1, 762.2),
    mk(' HQ4TLFJ02CAD   Connor Adams   2026-04-01 - 2026-04-30', 1, 749.6),
    mk(' Self-directed Non-Registered Margin Account', 1, 699.9),
  ]);
  assert.equal(h.productLabel, 'Wealthsimple Investing');
  assert.equal(h.accountSuffix, 'HQ4TLFJ02CAD');
  assert.equal(h.currency, 'CAD');
});

test('brokerage header detects managed TFSA label (real fixture)', () => {
  const h = parseWsBrokerageHeader([
    mk('ORDER EXECUTION ONLY ACCOUNT', 1, 798.8),
    mk(' Account No.   Owner   Statement Period', 1, 762.2),
    mk(' WK49ZLBK8CAD   Connor Adams   2025-02-01 - 2025-02-28', 1, 749.6),
    mk(' Tax-Free Savings Managed Cash Account', 1, 699.9),
  ]);
  assert.equal(h.productLabel, 'Wealthsimple TFSA');
  assert.equal(h.accountSuffix, 'WK49ZLBK8CAD');
});

test('brokerage header throws when the account value line is absent', () => {
  assert.throws(
    () =>
      parseWsBrokerageHeader([
        mk('ORDER EXECUTION ONLY ACCOUNT'),
        mk(' Account No.   Owner   Statement Period'),
      ]),
    /Account No\./,
  );
});

// ---------------------------------------------------------------------------
// Holdings (Task 7) — RIGHT-anchored, real fixture lines from /tmp/ws_brk_cad
// and /tmp/ws_brk_margin.
// ---------------------------------------------------------------------------

const CAD_HEADER: PdfLine[] = [
  mk('ORDER EXECUTION ONLY ACCOUNT', 1, 798.8),
  mk(' Account No.   Owner   Statement Period', 1, 762.2),
  mk(' HQ6LMLTK8CAD   Connor Adams   2025-05-01 - 2025-05-31', 1, 749.6),
  mk(' Tax-Free Savings SDI Cash Account', 1, 699.9),
];

test('brokerage parses self-directed (3-qty-col) Portfolio Equities holdings', () => {
  const lines: PdfLine[] = [
    ...CAD_HEADER,
    mk('Portfolio Equities', 2, 786.3),
    mk(' Symbol   Total Quantity   Segregated   Quantity on      Market       Market        Book', 2, 769.6),
    mk('Quantity         Loan    Price* ($)       Value ($)      Cost* ($)', 2, 759.9),
    mk('Canadian Equities and Alternatives', 2, 743.7),
    mk(' BRP Inc   DOO   5.0509   2.0509   3.0000   $60.45 CAD   $305.32   $463.39', 2, 732.5),
    mk('The Toronto-Dominion Bank   TD   2.0766   2.0766   0.0000   $94.77 CAD   $196.79   $163.43', 2, 687.5),
    mk('Vanguard S&P 500 Index ETF   VFV   21.9905   21.9905   0.0000   $143.95     $3,165.53   $3,042.25', 2, 665.0),
    mk('CAD', 2, 655.2),
    mk(' US Equities and Alternatives', 2, 636.6),
    mk(' Total   $4,028.96   $4,108.04', 2, 615.1),
    mk(' Activity - Current period', 2, 403.1),
  ];
  const result = wealthsimpleBrokerageParser.parse(lines, { defaultCurrency: 'CAD' });
  const holdings = result.holdings!;

  // The "Total" footer row must NOT be parsed as a holding.
  assert.equal(holdings.length, 3);

  const td = holdings.find((h) => h.security.symbol === 'TD')!;
  assert.equal(td.security.name, 'The Toronto-Dominion Bank');
  assert.equal(td.quantity, 2.0766); // first qty column = Total Quantity
  assert.equal(td.price, 94.77);
  assert.equal(td.marketValue, 196.79);
  assert.equal(td.costBasis, 163.43);
  assert.equal(td.currency, 'CAD'); // from "$94.77 CAD" suffix
  assert.equal(td.security.currency, 'CAD');
  assert.equal(td.statementDate, '2025-05-31'); // header.periodEnd
  assert.equal(td.security.assetType, null);
  assert.equal(td.unrealizedGainLoss, null);
  assert.equal(td.sourceReference, null);

  // VFV's price cell has no currency suffix (the orphan "CAD" wrapped to its
  // own bucket) → falls back to the current section currency (CAD).
  const vfv = holdings.find((h) => h.security.symbol === 'VFV')!;
  assert.equal(vfv.quantity, 21.9905);
  assert.equal(vfv.price, 143.95);
  assert.equal(vfv.marketValue, 3165.53);
  assert.equal(vfv.costBasis, 3042.25);
  assert.equal(vfv.currency, 'CAD');
});

test('brokerage parses managed (2-qty-col) holdings incl. USD currency from suffix', () => {
  const lines: PdfLine[] = [
    mk('ORDER EXECUTION ONLY ACCOUNT', 1, 798.8),
    mk(' Account No.   Owner   Statement Period', 1, 762.2),
    mk(' WK49ZLBK8CAD   Connor Adams   2025-02-01 - 2025-02-28', 1, 749.6),
    mk(' Tax-Free Savings Managed Cash Account', 1, 699.9),
    mk(' Portfolio Equities', 1, 354.4),
    mk(' Symbol   Total Quantity   Segregated         Market        Market         Book', 1, 337.7),
    mk('Quantity       Price* ($)        Value ($)       Cost* ($)', 1, 328.0),
    mk('Canadian Equities and Alternatives', 1, 311.8),
    mk(' BMO Canadian Bank Income Index ETF -         ZBI   0.1632   0.1632   $30.69 CAD   $5.00   $4.99', 1, 300.6),
    mk('CAD', 1, 290.8),
    mk('BMO Ultra Short-Term Bond ETF   ZST   0.6719   0.6719   $48.97 CAD   $32.90   $32.92', 1, 257.1),
    mk(' US Equities and Alternatives   (The conversion rate used to convert your month-end Market Value to CAD is: $1USD = $1.443800 CAD)', 1, 241.1),
    mk(' Series Portfolios - Panagram Bbb-b Clo            CLOZ   0.1123   0.1123   $27.08 USD   $4.39   $4.49', 1, 229.7),
    mk('ETF', 1, 219.9),
    mk(' Total   $49.74   $49.88', 1, 200.9),
    mk(' *Book Cost -   the total amount paid to purchase a security', 1, 180.7),
  ];
  const result = wealthsimpleBrokerageParser.parse(lines, { defaultCurrency: 'CAD' });
  const holdings = result.holdings!;

  // 3 real holdings (ZBI, ZST, CLOZ); "Total" + orphan "CAD"/"ETF" excluded.
  assert.equal(holdings.length, 3);

  const zbi = holdings.find((h) => h.security.symbol === 'ZBI')!;
  assert.equal(zbi.quantity, 0.1632); // 2 qty cols → first is Total Quantity
  assert.equal(zbi.price, 30.69);
  assert.equal(zbi.marketValue, 5.0);
  assert.equal(zbi.costBasis, 4.99);
  assert.equal(zbi.currency, 'CAD');

  // CLOZ is in the US section AND has a "$27.08 USD" suffix.
  const cloz = holdings.find((h) => h.security.symbol === 'CLOZ')!;
  assert.equal(cloz.security.name, 'Series Portfolios - Panagram Bbb-b Clo');
  assert.equal(cloz.quantity, 0.1123);
  assert.equal(cloz.price, 27.08);
  assert.equal(cloz.marketValue, 4.39);
  assert.equal(cloz.costBasis, 4.49);
  assert.equal(cloz.currency, 'USD'); // from "$27.08 USD" suffix
  assert.equal(cloz.security.currency, 'USD');
});
