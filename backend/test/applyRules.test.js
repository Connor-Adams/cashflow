const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findBestRule } = require('../src/import/applyRules');

test('findBestRule picks higher priority', () => {
  const rules = [
    { id: 1, merchantPattern: 'COFFEE', priority: 1, matchKind: 'substring' },
    { id: 2, merchantPattern: 'COFFEE SHOP', priority: 5, matchKind: 'substring' },
  ];
  const { rule, ambiguous } = findBestRule(rules, 'COFFEE SHOP');
  assert.equal(ambiguous, false);
  assert.equal(rule.id, 2);
});

test('findBestRule ambiguous on tie', () => {
  const rules = [
    { id: 1, merchantPattern: 'X', priority: 1, matchKind: 'substring' },
    { id: 2, merchantPattern: 'Y', priority: 1, matchKind: 'substring' },
  ];
  const { rule, ambiguous } = findBestRule(rules, 'XY');
  assert.equal(ambiguous, true);
  assert.equal(rule, null);
});
