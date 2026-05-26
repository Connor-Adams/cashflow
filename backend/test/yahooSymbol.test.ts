import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toYahooSymbol } from '../src/integrations/yahoo/symbol';

test('CAD-listed bare symbol → .TO suffix', () => {
  assert.equal(toYahooSymbol('XEQT', 'CAD'), 'XEQT.TO');
  assert.equal(toYahooSymbol('VFV', 'CAD'), 'VFV.TO');
  assert.equal(toYahooSymbol('TD', 'CAD'), 'TD.TO');
});

test('USD-listed bare symbol → unchanged', () => {
  assert.equal(toYahooSymbol('NVDA', 'USD'), 'NVDA');
  assert.equal(toYahooSymbol('AAPL', 'USD'), 'AAPL');
});

test('symbol already carrying a suffix is preserved', () => {
  assert.equal(toYahooSymbol('XEQT.TO', 'CAD'), 'XEQT.TO');
  assert.equal(toYahooSymbol('FOO.NE', 'CAD'), 'FOO.NE');
  assert.equal(toYahooSymbol('ASML.AS', 'EUR'), 'ASML.AS');
});

test('crypto-style pairs are passed through', () => {
  assert.equal(toYahooSymbol('BTC-USD', 'USD'), 'BTC-USD');
  assert.equal(toYahooSymbol('ETH-CAD', 'CAD'), 'ETH-CAD');
});

test('non-CAD non-USD currencies are not suffixed', () => {
  assert.equal(toYahooSymbol('BARC', 'GBP'), 'BARC');
});

test('empty / whitespace-only symbols are returned unchanged', () => {
  assert.equal(toYahooSymbol('', 'USD'), '');
  assert.equal(toYahooSymbol('   ', 'USD'), '');
});

test('case-insensitive currency match', () => {
  assert.equal(toYahooSymbol('XEQT', 'cad'), 'XEQT.TO');
  assert.equal(toYahooSymbol('XEQT', ' CAD '), 'XEQT.TO');
});
