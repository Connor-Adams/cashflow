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

test('brokerage label comes from the account-type line, not the statement-codes legend', () => {
  // Real-world regression: a Non-Registered account whose page-5 "Information
  // about Statement Codes" legend mentions FHSA/Tax-free must NOT be labeled
  // FHSA/TFSA. The label is the page-1 line after "Phone:".
  const h = parseWsBrokerageHeader([
    mk('ORDER EXECUTION ONLY ACCOUNT', 1, 798.8),
    mk(' Account No.   Owner   Statement Period', 1, 762.2),
    mk(' HQ4TLFJ02CAD   Connor Adams   2025-09-01 - 2025-09-30', 1, 749.6),
    mk('Phone: (416) 595-7200 Fax: (647) 245-1002', 1, 713.2),
    mk(' Self-directed Non-Registered Cash Account', 1, 699.9),
    mk('CONT - Contribution                 WDQ - FHSA Qualifying withdrawal', 5, 722.4),
    mk('TRFINTF - Tax-free transfer into the account', 5, 710.0),
  ]);
  assert.equal(h.productLabel, 'Wealthsimple Investing');
});

test('brokerage detects FHSA from a genuine FHSA account-type line', () => {
  const h = parseWsBrokerageHeader([
    mk('ORDER EXECUTION ONLY ACCOUNT', 1, 798.8),
    mk(' Account No.   Owner   Statement Period', 1, 762.2),
    mk(' HQ4TLFJ02CAD   Connor Adams   2025-09-01 - 2025-09-30', 1, 749.6),
    mk('Phone: (416) 595-7200 Fax: (647) 245-1002', 1, 713.2),
    mk(' First Home Savings SDI Cash Account', 1, 699.9),
  ]);
  assert.equal(h.productLabel, 'Wealthsimple FHSA');
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

// ---------------------------------------------------------------------------
// Activities (Task 8) — accumulate-until-next-row. Real fixture lines incl.
// wrap tails that START WITH A DATE (the reason a y-window does not work).
// ---------------------------------------------------------------------------

test('brokerage parses BUY activity (wrapped, executed-at date, qty, signed amount)', () => {
  const lines: PdfLine[] = [
    ...CAD_HEADER,
    mk(' Activity - Current period', 2, 403.1),
    mk(' Date   Transaction   Description   Debit ($)   Credit ($)   Balance ($)', 2, 386.4),
    mk(' 2025-05-02   BUY   TD - The Toronto-Dominion Bank: Bought 0.0243 shares (executed at                            $2.14   $0.00   $50.84', 2, 375.2),
    mk('2025-05-01)', 2, 365.4),
    mk('2025-05-14   FPLINT   Stock lending monthly interest payment   $0.00   $0.01   $50.85', 2, 270.2),
  ];
  const result = wealthsimpleBrokerageParser.parse(lines, { defaultCurrency: 'CAD' });
  const acts = result.investmentActivities!;

  const buy = acts.find((a) => a.activityType === 'buy')!;
  assert.equal(buy.security?.symbol, 'TD');
  assert.equal(buy.security?.name, 'The Toronto-Dominion Bank');
  assert.equal(buy.quantity, 0.0243);
  assert.equal(buy.amount, -2.14); // credit 0 − debit 2.14
  assert.equal(buy.tradeDate, '2025-05-01'); // executed-at, NOT the 05-02 row date
  assert.equal(buy.currency, 'CAD');
  assert.equal(buy.settlementDate, null);
  assert.match(buy.description, /executed at 2025-05-01\)/);

  const int = acts.find((a) => a.activityType === 'interest')!;
  assert.equal(int.amount, 0.01); // credit 0.01 − debit 0
  assert.equal(int.quantity, null);
  assert.equal(int.security, null);
  assert.equal(int.tradeDate, '2025-05-14'); // no executed-at → row date
});

test('brokerage drops zero-cash LOAN/RECALL rows but counts them in warnings', () => {
  const lines: PdfLine[] = [
    ...CAD_HEADER,
    mk(' Activity - Current period', 2, 403.1),
    mk(' Date   Transaction   Description   Debit ($)   Credit ($)   Balance ($)', 2, 386.4),
    mk('2025-05-02   LOAN   PLUR - Plurilock Security Inc.: 7.0000 Shares on loan (executed at                                 $0.00   $0.00   $50.84', 2, 354.2),
    mk('2025-05-02)', 2, 344.4),
    mk('2025-05-08   RECALL   PLUR - Plurilock Security Inc.: Loan of 7.0000 shares terminated (executed at                      $0.00   $0.00   $50.84', 2, 333.2),
    mk('2025-05-08)', 2, 323.4),
    mk('2025-05-14   FPLINT   Stock lending monthly interest payment   $0.00   $0.01   $50.85', 2, 270.2),
  ];
  const result = wealthsimpleBrokerageParser.parse(lines, { defaultCurrency: 'CAD' });
  const acts = result.investmentActivities!;
  // Only the FPLINT row survives; LOAN + RECALL are dropped.
  assert.equal(acts.length, 1);
  assert.equal(acts[0].activityType, 'interest');
  assert.ok(result.warnings.some((w) => /skip|LOAN|RECALL/i.test(w)));
  // The warning enumerates the skipped codes so nothing is silently lost.
  assert.ok(result.warnings.some((w) => /LOAN/.test(w) && /RECALL/.test(w)));
});

test('brokerage parses DIV wrapping 2 continuation lines (received-on date)', () => {
  const lines: PdfLine[] = [
    mk('ORDER EXECUTION ONLY ACCOUNT', 1, 798.8),
    mk(' Account No.   Owner   Statement Period', 1, 762.2),
    mk(' WK49ZLBK8CAD   Connor Adams   2025-02-01 - 2025-02-28', 1, 749.6),
    mk(' Tax-Free Savings Managed Cash Account', 1, 699.9),
    mk('Activity - Current period', 2, 786.3),
    mk(' Date   Transaction   Description   Debit ($)   Credit ($)   Balance ($)', 2, 769.6),
    mk(' 2025-02-01   CONT   Contribution (executed at 2025-02-01)   $0.00   $50.00   $50.00', 2, 758.4),
    mk('2025-02-10   DIV   CLOZ - Series Portfolios - Panagram Bbb-b Clo ETF: Cash dividend                              $0.00   $0.03   $0.15', 2, 642.1),
    mk('distribution, received on 2025-02-10, record date of 2025-02-04, FX Rate:', 2, 632.4),
    mk('1.4383', 2, 622.6),
    mk('2025-02-28   FEE   Management fees for period 2025-02-01 to 2025-02-28 (executed at                              $0.02   $0.00   $0.13', 2, 611.4),
    mk('2025-02-28)', 2, 601.6),
    mk('LEVERAGE DISCLOSURE', 3, 778.0),
  ];
  const result = wealthsimpleBrokerageParser.parse(lines, { defaultCurrency: 'CAD' });
  const acts = result.investmentActivities!;

  // CONT (transfer), DIV (dividend), FEE (fee) → 3 activities.
  assert.equal(acts.length, 3);

  const div = acts.find((a) => a.activityType === 'dividend')!;
  assert.equal(div.security?.symbol, 'CLOZ');
  assert.equal(div.security?.name, 'Series Portfolios - Panagram Bbb-b Clo ETF');
  assert.equal(div.amount, 0.03); // credit 0.03 − debit 0
  assert.equal(div.quantity, null); // dividends have no qty
  assert.equal(div.tradeDate, '2025-02-10'); // received on
  assert.match(div.description, /record date of 2025-02-04/); // continuation accumulated

  const cont = acts.find((a) => a.activityType === 'transfer')!;
  assert.equal(cont.amount, 50); // credit 50 − debit 0
  assert.equal(cont.security, null); // "Contribution ..." has no SYM - Name: pattern
  assert.equal(cont.tradeDate, '2025-02-01');

  const fee = acts.find((a) => a.activityType === 'fee')!;
  assert.equal(fee.amount, -0.02); // credit 0 − debit 0.02
  assert.equal(fee.tradeDate, '2025-02-28');
});

test('brokerage skips unmapped cash-account codes (e.g. SPEND) with a distinct warning', () => {
  // Cash/Chequing accounts flow through this parser and carry cash-movement
  // codes (EFT/SPEND/CASHBACK/OBP) the equity taxonomy does not map. They are
  // dropped (cash-side; out of scope for InvestmentActivity) but surfaced in a
  // warning under an "unmapped" tally so nothing is silently lost.
  const lines: PdfLine[] = [
    mk('ORDER EXECUTION ONLY ACCOUNT', 1, 798.8),
    mk(' Account No.   Owner   Statement Period', 1, 762.2),
    mk(' WK3DD9X35CAD   Connor Adams   2026-02-01 - 2026-02-28', 1, 749.6),
    mk('Phone: (416) 595-7200 Fax: (647) 245-1002', 1, 713.2),
    mk(' Chequing Account', 1, 699.9),
    mk(' Activity - Current period', 2, 786.3),
    mk(' Date   Transaction   Description   Debit ($)   Credit ($)   Balance ($)', 2, 769.6),
    mk('2026-02-27   SPEND   Cash correction (executed at 2026-02-27)   $14.11   $0.00   $1,053.88', 2, 758.4),
    mk('2026-02-15   INT   Interest received   $0.00   $1.20   $1,068.00', 2, 747.0),
  ];
  const result = wealthsimpleBrokerageParser.parse(lines, { defaultCurrency: 'CAD' });
  // Only the mapped INT row survives; SPEND is dropped.
  assert.equal(result.investmentActivities!.length, 1);
  assert.equal(result.investmentActivities![0].activityType, 'interest');
  assert.ok(result.warnings.some((w) => /unmapped-code/.test(w) && /SPEND/.test(w)));
});

test('brokerage tracks per-table currency in split CAD/USD margin activity', () => {
  const lines: PdfLine[] = [
    mk('ORDER EXECUTION ONLY ACCOUNT', 1, 798.8),
    mk(' Account No.   Owner   Statement Period', 1, 762.2),
    mk(' HQ4TLFJ02CAD   Connor Adams   2025-12-01 - 2025-12-31', 1, 749.6),
    mk(' Self-directed Non-Registered Margin Account', 1, 699.9),
    mk(' CAD Activity - Current period', 2, 679.9),
    mk(' Date   Transaction   Description   Debit ($CAD)   Credit ($CAD)   Balance ($CAD)', 2, 663.2),
    mk('2025-12-03   BUY   XEQT - iShares Core Equity ETF: Bought 1.0000 shares (executed at 2025-12-02)   $34.60   $0.00   $0.00', 2, 650.0),
    mk(' USD Activity - Current period', 2, 633.1),
    mk(' Date   Transaction   Description   Debit ($USD)   Credit ($USD)   Balance ($USD)', 2, 616.4),
    mk('2025-12-10   DIV   CLOZ - Panagram Clo ETF: Cash dividend distribution, received on 2025-12-10   $0.00   $0.05   $0.05', 2, 600.0),
    mk('STATEMENT NOTES', 3, 694.6),
  ];
  const result = wealthsimpleBrokerageParser.parse(lines, { defaultCurrency: 'CAD' });
  const acts = result.investmentActivities!;
  const buy = acts.find((a) => a.activityType === 'buy')!;
  assert.equal(buy.currency, 'CAD');
  assert.equal(buy.security?.currency, 'CAD');
  const div = acts.find((a) => a.activityType === 'dividend')!;
  assert.equal(div.currency, 'USD'); // under the "USD Activity" table
  assert.equal(div.security?.currency, 'USD');
});
