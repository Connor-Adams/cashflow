import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBestRule, type RuleRow } from '../src/import/applyRules';

test('findBestRule picks higher priority', () => {
  const rules: RuleRow[] = [
    {
      id: 1,
      merchantPattern: 'COFFEE',
      priority: 1,
      matchKind: 'substring',
      category: null,
      isBusiness: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
    },
    {
      id: 2,
      merchantPattern: 'COFFEE SHOP',
      priority: 5,
      matchKind: 'substring',
      category: null,
      isBusiness: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
    },
  ];
  const { rule, ambiguous } = findBestRule(rules, 'COFFEE SHOP');
  assert.equal(ambiguous, false);
  assert.equal(rule?.id, 2);
});

test('findBestRule ambiguous on tie', () => {
  const rules: RuleRow[] = [
    {
      id: 1,
      merchantPattern: 'X',
      priority: 1,
      matchKind: 'substring',
      category: null,
      isBusiness: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
    },
    {
      id: 2,
      merchantPattern: 'Y',
      priority: 1,
      matchKind: 'substring',
      category: null,
      isBusiness: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
    },
  ];
  const { rule, ambiguous } = findBestRule(rules, 'XY');
  assert.equal(ambiguous, true);
  assert.equal(rule, null);
});
