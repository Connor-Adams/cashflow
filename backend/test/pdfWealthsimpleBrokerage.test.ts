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
