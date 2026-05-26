import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enumerateYahooSymbols,
  toYahooSymbol,
} from '../src/integrations/yahoo/symbol';

test('CAD-listed bare symbol → .TO primary, .V + .CN fallbacks', () => {
  assert.deepEqual(
    enumerateYahooSymbols('XEQT', { currency: 'CAD', assetType: 'etf', name: null }),
    ['XEQT.TO', 'XEQT.V', 'XEQT.CN'],
  );
  assert.deepEqual(
    enumerateYahooSymbols('PLUR', { currency: 'CAD', assetType: 'equity', name: null }),
    ['PLUR.TO', 'PLUR.V', 'PLUR.CN'],
  );
});

test('USD-listed bare symbol → unchanged single candidate', () => {
  assert.deepEqual(
    enumerateYahooSymbols('NVDA', { currency: 'USD', assetType: 'equity', name: null }),
    ['NVDA'],
  );
});

test('cryptocurrency assetType → SYM-CUR pair, USD fallback for non-USD listings', () => {
  assert.deepEqual(
    enumerateYahooSymbols('BTC', { currency: 'CAD', assetType: 'cryptocurrency', name: 'Bitcoin' }),
    ['BTC-CAD', 'BTC-USD'],
  );
  assert.deepEqual(
    enumerateYahooSymbols('ETH', { currency: 'USD', assetType: 'cryptocurrency', name: 'Ethereum' }),
    ['ETH-USD'],
  );
  assert.deepEqual(
    enumerateYahooSymbols('XRP', { currency: 'CAD', assetType: 'cryptocurrency', name: 'XRP' }),
    ['XRP-CAD', 'XRP-USD'],
  );
});

test('CDR-named CAD equity → .NE primary, .TO fallback', () => {
  assert.deepEqual(
    enumerateYahooSymbols('NVDA', {
      currency: 'CAD',
      assetType: 'equity',
      name: 'Nvidia CDR (CAD Hedged)',
    }),
    ['NVDA.NE', 'NVDA.TO'],
  );
  // case-insensitive
  assert.deepEqual(
    enumerateYahooSymbols('MSFT', {
      currency: 'CAD',
      assetType: 'equity',
      name: 'Microsoft cdr (CAD Hedged)',
    }),
    ['MSFT.NE', 'MSFT.TO'],
  );
});

test('symbol already carrying a suffix or pair separator is preserved', () => {
  assert.deepEqual(
    enumerateYahooSymbols('XEQT.TO', { currency: 'CAD', assetType: null, name: null }),
    ['XEQT.TO'],
  );
  assert.deepEqual(
    enumerateYahooSymbols('FOO.NE', { currency: 'CAD', assetType: null, name: null }),
    ['FOO.NE'],
  );
  assert.deepEqual(
    enumerateYahooSymbols('BTC-USD', { currency: 'USD', assetType: 'cryptocurrency', name: null }),
    ['BTC-USD'],
  );
});

test('non-CAD non-USD equity → bare symbol single candidate', () => {
  assert.deepEqual(
    enumerateYahooSymbols('BARC', { currency: 'GBP', assetType: 'equity', name: null }),
    ['BARC'],
  );
});

test('empty / whitespace-only symbols return empty list', () => {
  assert.deepEqual(enumerateYahooSymbols('', { currency: 'USD', assetType: null, name: null }), []);
  assert.deepEqual(enumerateYahooSymbols('   ', { currency: 'USD', assetType: null, name: null }), []);
});

test('toYahooSymbol returns the primary candidate', () => {
  assert.equal(toYahooSymbol('XEQT', 'CAD'), 'XEQT.TO');
  assert.equal(
    toYahooSymbol('BTC', 'CAD', { assetType: 'cryptocurrency', name: 'Bitcoin' }),
    'BTC-CAD',
  );
  assert.equal(
    toYahooSymbol('NVDA', 'CAD', { assetType: 'equity', name: 'Nvidia CDR (CAD Hedged)' }),
    'NVDA.NE',
  );
  assert.equal(toYahooSymbol('NVDA', 'USD'), 'NVDA');
});
