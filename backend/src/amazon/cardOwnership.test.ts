import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAccountLast4,
  buildLast4Map,
  classifyCardOwnership,
  classifyCardOwnershipForVendor,
} from './cardOwnership';

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

// Task 15 scope correction: production has zero accepted Amazon links and 7
// accepted non-Amazon links (6 costco, 1 uber_eats) -- the exclusion (and by
// extension, the DTO classification for display) was designed for Amazon
// only. `classifyCardOwnershipForVendor` is the single place that folds a
// non-Amazon 'foreign' result into 'known', so every serializer can reuse it
// instead of reimplementing the vendor guard.
test('classifyCardOwnershipForVendor: only vendor amazon may ever be foreign', () => {
  const map = buildLast4Map([{ id: 1, shortCode: '701001' }]); // -> last4 '1001'

  // Amazon, last4 matches no account -> genuinely foreign.
  assert.equal(classifyCardOwnershipForVendor('amazon', '2662', map), 'foreign');
  // Amazon, last4 matches -> known.
  assert.equal(classifyCardOwnershipForVendor('amazon', '1001', map), 'known');
  // Amazon, no last4 at all -> unknown.
  assert.equal(classifyCardOwnershipForVendor('amazon', null, map), 'unknown');

  // Costco (or any non-Amazon vendor), last4 matches no account -> the raw
  // classifier would say 'foreign', but a non-Amazon order must never
  // display as foreign -- it folds to 'known'.
  assert.equal(classifyCardOwnershipForVendor('costco', '3114', map), 'known');
  assert.equal(classifyCardOwnershipForVendor('uber_eats', '9999', map), 'known');
  // Non-Amazon, last4 matches an account -> known regardless.
  assert.equal(classifyCardOwnershipForVendor('costco', '1001', map), 'known');
  // Non-Amazon, no last4 at all -> unknown, same as the raw classifier.
  assert.equal(classifyCardOwnershipForVendor('costco', null, map), 'unknown');
});
