import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccountLast4, buildLast4Map, classifyCardOwnership } from './cardOwnership';

test('extracts the last 4 digits from an all-numeric short code', () => {
  assert.equal(resolveAccountLast4('701001'), '1001'); // Amex Reserve
  assert.equal(resolveAccountLast4('741005'), '1005'); // Amex Cobalt
  assert.equal(resolveAccountLast4('5234'), '5234');   // RBC Avion
});

test('returns null for opaque alphanumeric short codes', () => {
  assert.equal(resolveAccountLast4('HQ6LMLTK8CAD'), null); // Wealthsimple
  assert.equal(resolveAccountLast4('costco'), null);
  assert.equal(resolveAccountLast4('C13BRX957CAD'), null);
});

test('returns null for null, empty and too-short codes', () => {
  assert.equal(resolveAccountLast4(null), null);
  assert.equal(resolveAccountLast4(''), null);
  assert.equal(resolveAccountLast4('123'), null);
});

test('classifies an order against the household map', () => {
  const map = buildLast4Map([
    { id: 1, shortCode: '701001' },
    { id: 40, shortCode: '741005' },
    { id: 8, shortCode: 'HQ6LMLTK8CAD' },
  ]);

  assert.equal(classifyCardOwnership('1001', map), 'known');
  assert.equal(classifyCardOwnership('1005', map), 'known');
  assert.equal(classifyCardOwnership('2662', map), 'foreign');
  assert.equal(classifyCardOwnership(null, map), 'unknown');
});

test('two accounts sharing a last4 still classify as known', () => {
  const map = buildLast4Map([
    { id: 1, shortCode: '701001' },
    { id: 2, shortCode: '881001' },
  ]);
  assert.deepEqual(map.get('1001'), [1, 2]);
  assert.equal(classifyCardOwnership('1001', map), 'known');
});
