import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runApplyRuleStage } from '../src/import/enrichment/applyRuleStage';
import type { RuleRow } from '../src/import/applyRules';

function rule(overrides: Partial<RuleRow> & { id: number; merchantPattern: string }): RuleRow {
  return {
    priority: 1,
    matchKind: 'substring',
    category: null,
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    ...overrides,
  } as RuleRow;
}

test('emits rule signal with high confidence on unambiguous match', () => {
  const signals = runApplyRuleStage({
    merchantClean: 'NETFLIX',
    rules: [rule({ id: 7, merchantPattern: 'NETFLIX', category: 'Subscriptions', isBusiness: false, splitType: 'shared', pctMe: '0.5', pctPartner: '0.5' })],
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'rule');
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.autoCategory, 'Subscriptions');
  assert.equal(signals[0].fields.autoSplitType, 'shared');
  assert.equal(signals[0].fields.appliedRuleId, 7);
});

test('emits no signal when no rules match', () => {
  const signals = runApplyRuleStage({
    merchantClean: 'UNKNOWN MERCHANT',
    rules: [rule({ id: 1, merchantPattern: 'NETFLIX' })],
  });
  assert.equal(signals.length, 0);
});

test('emits no signal when rule match is ambiguous', () => {
  const signals = runApplyRuleStage({
    merchantClean: 'COFFEE',
    rules: [
      rule({ id: 1, merchantPattern: 'COFFEE', priority: 5 }),
      rule({ id: 2, merchantPattern: 'COFFEE', priority: 5 }),
    ],
  });
  assert.equal(signals.length, 0);
});
