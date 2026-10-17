import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWsHoldingsReport } from './wsHoldingsReport';

// Wealthsimple retired the per-account statement exports; this multi-account
// holdings report is now the only file they produce. Fixtures are copied
// verbatim from holdings-report-2026-09-16.csv.

const HEADER = [
  'Account Name', 'Account Type', 'Account Classification', 'Account Number',
  'Symbol', 'Exchange', 'MIC', 'Name', 'Security Type', 'Quantity',
  'Position Direction', 'Market Price', 'Market Price Currency',
  'Book Value (CAD)', 'Book Value Currency (CAD)', 'Book Value (Market)',
  'Book Value Currency (Market)', 'Market Value', 'Market Value Currency',
  'Market Unrealized Returns', 'Market Unrealized Returns Currency',
].join(',');

const VFV = '"Corporate investing","Corporate investing","Trade","HQ8H0GZ07CAD","VFV","TSX","XTSE","Vanguard Investments Canada Inc. - S&P 500 Index ETF","EXCHANGE_TRADED_FUND","200.8294","LONG","187.77","CAD","33652.527600064763798789906802","CAD","33652.527600064763798789906802","CAD","37709.736438","CAD","4057.208837935236201210093198","CAD"';
const BTC = '"Crypto","Crypto","Trade","HQ6R28910CAD","BTC","","","Bitcoin","CRYPTOCURRENCY","0.00233675","LONG","106883.8442023","CAD","276.01","CAD","276.01","CAD","249.828338585502625","CAD","-26.181661414497375","CAD"';
const CASH = '"Corporate investing","Corporate investing","Trade","HQ8H0GZ07CAD","CAD","","","CAD","CURRENCY","10000.03","LONG","1","CAD","10000.03","CAD","10000.03","CAD","10000.03","CAD","0","CAD"';
const TRAILER = '"As of 2026-09-16 20:42 GMT-04:00"';

function csv(...rows: string[]): string {
  return [HEADER, ...rows, TRAILER].join('\n');
}

test('takes the as-of date from the trailer row', () => {
  const r = parseWsHoldingsReport(csv(VFV));
  assert.equal(r.statementDate, '2026-09-16');
  assert.deepEqual(r.parseErrors, []);
});

test('groups positions by account number, not by account name', () => {
  const r = parseWsHoldingsReport(csv(VFV, BTC, CASH));
  assert.deepEqual(
    r.slices.map((s) => [s.wsid, s.accountLabel, s.holdings.length]),
    [['HQ8H0GZ07CAD', 'Corporate investing', 2], ['HQ6R28910CAD', 'Crypto', 1]],
  );
});

test('maps a position onto the holding-snapshot shape', () => {
  const [slice] = parseWsHoldingsReport(csv(VFV)).slices;
  const h = slice.holdings[0];
  assert.equal(h.statementDate, '2026-09-16');
  assert.deepEqual(h.security, {
    symbol: 'VFV',
    name: 'Vanguard Investments Canada Inc. - S&P 500 Index ETF',
    assetType: 'exchange_traded_fund',
    currency: 'CAD',
  });
  assert.equal(h.quantity, 200.8294);
  assert.equal(h.price, 187.77);
  // marketValue is DECIMAL(14,4) — rounded to what the column can hold.
  assert.equal(h.marketValue, 37709.7364);
  assert.equal(h.currency, 'CAD');
});

test('rounds book value to what the column can hold', () => {
  // Wealthsimple prints 30 decimal places; costBasis is DECIMAL(14,4).
  const [slice] = parseWsHoldingsReport(csv(VFV)).slices;
  assert.equal(slice.holdings[0].costBasis, 33652.5276);
  assert.equal(slice.holdings[0].unrealizedGainLoss, 4057.2088);
});

test('a cash position is a holding like any other', () => {
  const [slice] = parseWsHoldingsReport(csv(CASH)).slices;
  assert.equal(slice.holdings[0].security.assetType, 'currency');
  assert.equal(slice.holdings[0].quantity, 10000.03);
});

test('a SHORT position carries a negative quantity', () => {
  const short = VFV.replace('"LONG"', '"SHORT"');
  const [slice] = parseWsHoldingsReport(csv(short)).slices;
  assert.equal(slice.holdings[0].quantity, -200.8294);
});

test('the fingerprint is stable per account+security+date, so a re-import is a no-op', () => {
  const first = parseWsHoldingsReport(csv(VFV)).slices[0].holdings[0];
  const again = parseWsHoldingsReport(csv(VFV)).slices[0].holdings[0];
  assert.equal(first.sourceRowFingerprint, again.sourceRowFingerprint);

  // A later report of the same position must NOT collide — it is a new snapshot.
  const laterCsv = csv(VFV).replace('2026-09-16 20:42', '2026-10-16 20:42');
  const later = parseWsHoldingsReport(laterCsv).slices[0].holdings[0];
  assert.notEqual(first.sourceRowFingerprint, later.sourceRowFingerprint);
});

test('a report with no trailer is an error, not a silent guess at the date', () => {
  const r = parseWsHoldingsReport([HEADER, VFV].join('\n'));
  assert.equal(r.slices.length, 0);
  assert.equal(r.parseErrors.length, 1);
  assert.match(r.parseErrors[0].message, /as of/i);
});

test('an unparseable quantity is reported, not silently dropped', () => {
  const bad = VFV.replace('"200.8294"', '"n/a"');
  const r = parseWsHoldingsReport(csv(bad));
  assert.deepEqual(r.slices, []);
  assert.equal(r.parseErrors.length, 1);
  assert.match(r.parseErrors[0].message, /quantity/i);
});
