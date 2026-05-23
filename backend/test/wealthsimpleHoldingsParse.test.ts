import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWsHoldingsCsv } from '../src/import/wealthsimpleHoldingsParse';

const HEADER =
  'Account Name,Account Type,Account Classification,Account Number,Symbol,Exchange,MIC,Name,Security Type,Quantity,Position Direction,Market Price,Market Price Currency,Book Value (CAD),Book Value Currency (CAD),Book Value (Market),Book Value Currency (Market),Market Value,Market Value Currency,Market Unrealized Returns,Market Unrealized Returns Currency';

const ETF_ROW =
  '"TFSA","TFSA","Trade","HQ6LMLTK8CAD","VFV","TSX","XTSE","Vanguard Investments Canada Inc. - S&P 500 Index ETF","EXCHANGE_TRADED_FUND","37.3167","LONG","183.2","CAD","5498.1","CAD","5498.1","CAD","6836.41944","CAD","1338.31944","CAD"';

const EQUITY_ROW =
  '"TFSA","TFSA","Trade","HQ6LMLTK8CAD","TD","TSX","XTSE","The Toronto-Dominion Bank","EQUITY","4.1507","LONG","154.69","CAD","457.69","CAD","457.69","CAD","642.071783","CAD","184.381783","CAD"';

const CRYPTO_ROW =
  '"Crypto","Crypto","Trade","HQ6R28910CAD","BTC","","","Bitcoin","CRYPTOCURRENCY","0.00233675","LONG","103856.665017","CAD","276.01","CAD","276.01","CAD","242.963237233665","CAD","-33.046762766335","CAD"';

const METAL_ROW =
  '"Corporate investing","Corporate investing","Trade","HQ8H0GZ07CAD","GOLD","","","Physically backed gold","PRECIOUS_METAL","0.4769142478","LONG","6233.23","CAD","3500","CAD","3500","CAD","2972.716196814394","CAD","-527.283803185606","CAD"';

const AS_OF = '"As of 2026-05-23 10:14 GMT-04:00"';

function build(rows: string[], trailer = AS_OF): string {
  return [HEADER, ...rows, '', trailer].join('\n');
}

test('parses ETF, equity, crypto, and precious-metal rows from a mixed report', () => {
  const csv = build([ETF_ROW, EQUITY_ROW, CRYPTO_ROW, METAL_ROW]);
  const out = parseWsHoldingsCsv(csv);
  assert.ok(!('error' in out), `expected ok, got ${JSON.stringify(out)}`);
  assert.equal(out.statementDate, '2026-05-23');
  assert.equal(out.rows.length, 4);

  const vfv = out.rows.find((r) => r.symbol === 'VFV')!;
  assert.equal(vfv.accountShortCode, 'HQ6LMLTK8CAD');
  assert.equal(vfv.assetType, 'exchange_traded_fund');
  assert.equal(vfv.currency, 'CAD');
  assert.equal(vfv.quantity, 37.3167);
  assert.equal(vfv.price, 183.2);
  assert.equal(vfv.marketValue, 6836.41944);
  assert.equal(vfv.costBasis, 5498.1);
  assert.equal(vfv.unrealizedGainLoss, 1338.31944);

  const td = out.rows.find((r) => r.symbol === 'TD')!;
  assert.equal(td.assetType, 'equity');
  assert.equal(td.name, 'The Toronto-Dominion Bank');

  const btc = out.rows.find((r) => r.symbol === 'BTC')!;
  assert.equal(btc.assetType, 'cryptocurrency');
  assert.equal(btc.accountShortCode, 'HQ6R28910CAD');
  // empty Exchange/MIC must not break parsing
  assert.equal(btc.quantity, 0.00233675);

  const gold = out.rows.find((r) => r.symbol === 'GOLD')!;
  assert.equal(gold.assetType, 'precious_metal');
  assert.equal(gold.unrealizedGainLoss, -527.283803185606);
});

test('extracts trailing "As of …" date and ignores trailing blank lines', () => {
  const csv = [HEADER, ETF_ROW, '', '', AS_OF, '', ''].join('\n');
  const out = parseWsHoldingsCsv(csv);
  assert.ok(!('error' in out));
  assert.equal(out.statementDate, '2026-05-23');
  assert.equal(out.rows.length, 1);
});

test('handles As-of trailer without surrounding quotes', () => {
  const csv = [HEADER, ETF_ROW, 'As of 2026-05-23 10:14 GMT-04:00'].join('\n');
  const out = parseWsHoldingsCsv(csv);
  assert.ok(!('error' in out));
  assert.equal(out.statementDate, '2026-05-23');
});

test('missing trailing "As of" line returns an error', () => {
  const csv = [HEADER, ETF_ROW].join('\n');
  const out = parseWsHoldingsCsv(csv);
  assert.ok('error' in out, `expected error, got ${JSON.stringify(out)}`);
  assert.match(out.error, /As of/);
});

test('empty Symbol row is skipped with a warning', () => {
  const noSymRow =
    '"TFSA","TFSA","Trade","HQ6LMLTK8CAD","","TSX","XTSE","Some Name","EQUITY","10","LONG","1","CAD","10","CAD","10","CAD","10","CAD","0","CAD"';
  const csv = build([ETF_ROW, noSymRow]);
  const out = parseWsHoldingsCsv(csv);
  assert.ok(!('error' in out));
  assert.equal(out.rows.length, 1);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /Symbol/);
});

test('empty Account Number row is skipped with a warning', () => {
  const noAcctRow =
    '"TFSA","TFSA","Trade","","XYZ","TSX","XTSE","Some Name","EQUITY","10","LONG","1","CAD","10","CAD","10","CAD","10","CAD","0","CAD"';
  const csv = build([ETF_ROW, noAcctRow]);
  const out = parseWsHoldingsCsv(csv);
  assert.ok(!('error' in out));
  assert.equal(out.rows.length, 1);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /Account Number/);
});

test('missing required header column returns an error', () => {
  // Header is missing "Account Number" — should fail loudly, not silently.
  const badHeader =
    'Account Name,Symbol,Name,Security Type,Quantity,Market Value Currency';
  const csv = [
    badHeader,
    '"TFSA","VFV","S&P 500","EXCHANGE_TRADED_FUND","10","CAD"',
    AS_OF,
  ].join('\n');
  const out = parseWsHoldingsCsv(csv);
  assert.ok('error' in out);
  assert.match(out.error, /Account Number/);
});

test('quantity that fails to parse skips the row', () => {
  const badQty =
    '"TFSA","TFSA","Trade","HQ6LMLTK8CAD","VFV","TSX","XTSE","Vanguard","EXCHANGE_TRADED_FUND","not-a-number","LONG","183.2","CAD","5498.1","CAD","5498.1","CAD","6836.41944","CAD","1338.31944","CAD"';
  const csv = build([ETF_ROW, badQty]);
  const out = parseWsHoldingsCsv(csv);
  assert.ok(!('error' in out));
  assert.equal(out.rows.length, 1);
  assert.match(out.warnings[0], /Quantity/);
});

test('null-able numeric fields parse as null when blank', () => {
  // Market Price, Market Value, Book Value (CAD), Market Unrealized Returns all blank.
  const blanks =
    '"TFSA","TFSA","Trade","HQ6LMLTK8CAD","XYZ","TSX","XTSE","Some Sec","EQUITY","1","LONG","","","","CAD","","CAD","","CAD","","CAD"';
  const csv = build([blanks]);
  const out = parseWsHoldingsCsv(csv);
  assert.ok(!('error' in out));
  assert.equal(out.rows.length, 1);
  const r = out.rows[0];
  assert.equal(r.price, null);
  assert.equal(r.marketValue, null);
  assert.equal(r.costBasis, null);
  assert.equal(r.unrealizedGainLoss, null);
});
