import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine, PdfTextSpan } from './types';
import { parseWsActivityStatement } from './wsActivityStatement';

let y = 800;
/** A line whose spans carry x-positions, as pdfjs delivers them. */
function mk(...spans: [number, string][]): PdfLine {
  const items: PdfTextSpan[] = spans.map(([x, str]) => ({ x, width: str.length * 5, str }));
  return { page: 1, y: y--, text: items.map((s) => s.str).join(' '), items };
}
function plain(text: string): PdfLine {
  return mk([43, text]);
}

// Fixtures are copied verbatim from ACTIVITY_STATEMENT_2026-06-02_2026-09-03.pdf.
// Wealthsimple retired per-account exports, so this on-demand statement is the
// only remaining source of buys, sells, dividends and interest.

function preamble(): PdfLine[] {
  return [
    plain('Wealthsimple Investments Inc.'),
    plain('Custom Activity Statement'),
    plain('Connor Douglas Greene Adams'),
    plain('This letter is intended to show the transaction activity for Connor Douglas Greene Adams from Jun 2, 2026 to Sep 3, 2026.'),
  ];
}

function columnHeader(): PdfLine[] {
  return [
    mk([51, 'Transaction'], [112, 'Settlement']),
    mk([172, 'Transaction Description Debit Credit Currency']),
    mk([51, 'Date'], [112, 'Date ']),
  ];
}

test('splits into one slice per account, keyed on the WSID', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('TFSA (HQ6LMLTK8CAD)'),
    plain('CAD Activity'),
    ...columnHeader(),
    mk([51, '2026-06-12 INTEREST Stock lending monthly interest payment $0.01 CAD']),
    plain('RRSP (HQ9L47L40CAD)'),
    plain('CAD Activity'),
    ...columnHeader(),
    mk([51, '2026-07-01 EFT Deposit (executed at 2026-07-01) $250.00 CAD']),
  ]);
  assert.deepEqual(r.parseErrors, []);
  assert.deepEqual(
    r.slices.map((s) => [s.wsid, s.accountLabel, s.activities.length]),
    [['HQ6LMLTK8CAD', 'TFSA', 1], ['HQ9L47L40CAD', 'RRSP', 1]],
  );
});

test('an account with no activity yields an empty slice, not an error', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('Non-registered margin (HQ4TLFJ02CAD)'),
    plain('No activities were recorded for this account during the specified period.'),
  ]);
  assert.deepEqual(r.parseErrors, []);
  assert.deepEqual(r.slices.map((s) => [s.wsid, s.activities.length]), [['HQ4TLFJ02CAD', 0]]);
});

test('a buy is a debit and carries its settlement date', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('TFSA (HQ6LMLTK8CAD)'),
    ...columnHeader(),
    mk([250, 'TWC - TWC Enterprises Ltd: Bought 0.0058 shares']),
    mk([51, '2026-06-15 2026-06-16 BUY '], [436, '$0.15 CAD']),
    mk([250, 'at $25.75 per share (executed at 2026-06-15) ']),
  ]);
  assert.deepEqual(r.parseErrors, []);
  const [a] = r.slices[0].activities;
  assert.equal(a.activityType, 'buy');
  assert.equal(a.tradeDate, '2026-06-15');
  assert.equal(a.settlementDate, '2026-06-16');
  assert.equal(a.amount, -0.15, 'a purchase leaves the account');
  assert.equal(a.currency, 'CAD');
  assert.equal(a.security?.symbol, 'TWC');
  assert.match(a.description, /Bought 0\.0058 shares at \$25\.75 per share/);
});

test('a dividend is a credit', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('TFSA (HQ6LMLTK8CAD)'),
    ...columnHeader(),
    mk([250, 'XEQT - iShares Core Equity ETF Portfolio: Cash']),
    mk([51, '2026-06-30 DIVIDEND'], [250, 'dividend distribution, received on 2026-06-30,'], [478, '$26.89 CAD']),
    mk([250, 'record date of 2026-06-25']),
  ]);
  const [a] = r.slices[0].activities;
  assert.equal(a.activityType, 'dividend');
  assert.equal(a.amount, 26.89);
  assert.equal(a.settlementDate, null);
  assert.equal(a.security?.symbol, 'XEQT');
});

test('a description wrapping above AND below the row is stitched back together', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('FHSA (HQ6MDHJ67CAD)'),
    ...columnHeader(),
    mk([227, 'VFV - Vanguard Investments Canada Inc. - S&P 500 Index ETF:']),
    mk([51, '2026-07-07 2026-07-08 BUY'], [227, 'Bought 0.0859 shares at $189.19 per share (executed at'], [448, '$16.25 CAD']),
    mk([227, '2026-07-07)']),
  ]);
  const [a] = r.slices[0].activities;
  assert.equal(
    a.description,
    'VFV - Vanguard Investments Canada Inc. - S&P 500 Index ETF: Bought 0.0859 shares at $189.19 per share (executed at 2026-07-07)',
  );
  assert.equal(a.security?.symbol, 'VFV');
});

test('consecutive wrapped rows do not bleed into each other', () => {
  // Two CONSOLIDATION rows, each with description text both above and below.
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('TFSA (HQ6LMLTK8CAD)'),
    ...columnHeader(),
    mk([250, 'EPG - Emc Gold Corp: Corrected quantity of shares']),
    mk([51, '2026-06-03 CONSOLIDATION '], [436, '$0.00 CAD']),
    mk([250, 'by -16700.0000 (executed at 2026-06-03) ']),
    mk([250, 'EPG - Epic Gold Corp.: Corrected quantity of']),
    mk([51, '2026-06-03 CONSOLIDATION '], [436, '$0.00 CAD']),
    mk([250, 'shares by 3340.0000 (executed at 2026-06-03) ']),
  ]);
  assert.deepEqual(r.parseErrors, []);
  const [first, second] = r.slices[0].activities;
  assert.match(first.description, /Emc Gold Corp.*by -16700\.0000/);
  assert.doesNotMatch(first.description, /Epic Gold/);
  assert.match(second.description, /Epic Gold Corp.*shares by 3340\.0000/);
});

test('a row with no security is still recorded', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('RRSP (HQ9L47L40CAD)'),
    ...columnHeader(),
    mk([51, '2026-07-01 EFT Deposit (executed at 2026-07-01) $250.00 CAD']),
  ]);
  const [a] = r.slices[0].activities;
  assert.equal(a.activityType, 'transfer_in');
  assert.equal(a.amount, 250);
  assert.equal(a.security, null);
});

test('non-resident tax is a debit', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('FHSA (HQ6MDHJ67CAD)'),
    ...columnHeader(),
    mk([51, '2026-07-06 NRT Non-resident tax (executed at 2026-07-06) $0.09 CAD']),
  ]);
  const [a] = r.slices[0].activities;
  assert.equal(a.activityType, 'fee');
  assert.equal(a.amount, -0.09);
});

test('page furniture repeating mid-section is not a transaction', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('TFSA (HQ6LMLTK8CAD)'),
    ...columnHeader(),
    mk([51, '2026-06-12 INTEREST Stock lending monthly interest payment $0.01 CAD']),
    mk([291, 'Page 1 of 4']),
    ...columnHeader(),
    mk([51, '2026-07-15 INTEREST Stock lending monthly interest payment $0.01 CAD']),
  ]);
  assert.deepEqual(r.parseErrors, []);
  assert.equal(r.slices[0].activities.length, 2);
});

test('an unknown activity code is reported rather than guessed at', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('TFSA (HQ6LMLTK8CAD)'),
    ...columnHeader(),
    mk([51, '2026-06-12 WOMBAT Something new $1.00 CAD']),
  ]);
  assert.equal(r.slices[0].activities.length, 0);
  assert.equal(r.parseErrors.length, 1);
  assert.match(r.parseErrors[0].message, /WOMBAT/);
});

test('fingerprints distinguish same-day same-amount rows', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('TFSA (HQ6LMLTK8CAD)'),
    ...columnHeader(),
    mk([250, 'EPG - Emc Gold Corp: Corrected quantity of shares']),
    mk([51, '2026-06-03 CONSOLIDATION '], [436, '$0.00 CAD']),
    mk([250, 'EPG - Epic Gold Corp.: Corrected quantity of']),
    mk([51, '2026-06-03 CONSOLIDATION '], [436, '$0.00 CAD']),
  ]);
  const [a, b] = r.slices[0].activities;
  assert.notEqual(a.sourceRowFingerprint, b.sourceRowFingerprint);
});

// --- bugs the real statement exposed that synthetic fixtures did not ---

test("a self-contained row does not inherit the previous row's description", () => {
  // INTEREST prints entirely inline. It followed a DIVIDEND whose description
  // wrapped, and picked up "EPG - Epic Gold Corp…" instead of its own text.
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('TFSA (HQ6LMLTK8CAD)'),
    ...columnHeader(),
    mk([250, 'EPG - Epic Gold Corp.: Corrected quantity of']),
    mk([51, '2026-06-03 CONSOLIDATION '], [436, '$0.00 CAD']),
    mk([250, 'shares by 3340.0000 (executed at 2026-06-03) ']),
    mk([51, '2026-06-12 INTEREST Stock lending monthly interest payment $0.01 CAD']),
  ]);
  const interest = r.slices[0].activities[1];
  assert.equal(interest.description, 'Stock lending monthly interest payment');
  assert.equal(interest.security, null, 'no ticker, so no security');
});

test('a description that names no ticker still reaches its own row', () => {
  // TRANSFER_TF's description wraps around it and starts with prose, not a
  // symbol — it must not be swallowed by the dividend above it.
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('Corporate investing (HQ8H0GZ07CAD)'),
    ...columnHeader(),
    mk([234, 'VFV - Vanguard Investments Canada Inc. - S&P 500']),
    mk([51, '2026-07-06 DIVIDEND'], [234, 'Index ETF: Cash dividend distribution, received on'], [474, '$68.85 CAD']),
    mk([234, '2026-07-06, record date of 2026-06-26']),
    mk([234, 'Money transfer into the account (executed at']),
    mk([51, '2026-07-06 TRANSFER_TF '], [474, '$10,000.00 CAD']),
    mk([234, '2026-07-06) ']),
  ]);
  assert.deepEqual(r.parseErrors, []);
  const [dividend, transfer] = r.slices[0].activities;
  assert.match(dividend.description, /record date of 2026-06-26$/);
  assert.doesNotMatch(dividend.description, /Money transfer/);
  assert.equal(transfer.activityType, 'transfer_in');
  assert.equal(transfer.amount, 10000);
  assert.equal(transfer.description, 'Money transfer into the account (executed at 2026-07-06)');
  assert.equal(transfer.security, null);
});

test('repeated column headers never become description text', () => {
  const r = parseWsActivityStatement([
    ...preamble(),
    plain('FHSA (HQ6MDHJ67CAD)'),
    plain('CAD Activity'),
    ...columnHeader(),
    mk([51, '2026-06-12 INTEREST Stock lending monthly interest payment $0.01 CAD']),
  ]);
  const [a] = r.slices[0].activities;
  assert.equal(a.description, 'Stock lending monthly interest payment');
  assert.doesNotMatch(a.description, /Debit|Credit|Settlement/);
});
