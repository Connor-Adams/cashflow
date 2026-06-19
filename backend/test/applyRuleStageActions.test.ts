import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runApplyRuleStage } from '../src/import/enrichment/applyRuleStage';
import type { RuleRow } from '../src/import/applyRules';

function baseRule(overrides: Partial<RuleRow>): RuleRow {
  return {
    id: 1,
    merchantPattern: 'NETFLIX',
    priority: 0,
    matchKind: 'substring',
    category: null,
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  };
}

// AC #6 — scalar-effect rule with no actions[] produces the identical
// source:'rule' Signal fields as before #795, and NO ruleActions side-channel.
test('applyRuleStage: scalar rule emits unchanged Signal fields, no ruleActions', () => {
  const rule = baseRule({
    category: 'Streaming',
    isBusiness: true,
    splitType: 'shared',
    pctMe: '0.5',
    pctPartner: '0.5',
  });
  const signals = runApplyRuleStage({ merchantClean: 'NETFLIX', rules: [rule], txnDate: '2026-06-01' });
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0].fields, {
    autoCategory: 'Streaming',
    autoBusiness: true,
    autoSplitType: 'shared',
    autoPctMe: '0.5',
    autoPctPartner: '0.5',
    appliedRuleId: 1,
  });
  assert.equal(signals[0].ruleActions, undefined);
});

// AC #7 — a rule with multiple actions surfaces set_label + set_alert on the
// side-channel while the scalar fields stay populated from set_category.
test('applyRuleStage: multi-action rule surfaces labelIds + alerts side-channel', () => {
  const rule = baseRule({
    category: 'Dining',
    actions: [
      { type: 'set_category', payload: { category: 'Dining' } },
      { type: 'set_label', payload: { labelId: 7 } },
      { type: 'set_label', payload: { labelId: 9 } },
      { type: 'set_alert', payload: { severity: 'warn', title: 'Watch this vendor' } },
    ],
  });
  const signals = runApplyRuleStage({ merchantClean: 'NETFLIX', rules: [rule], txnDate: '2026-06-01' });
  assert.equal(signals.length, 1);
  // Scalar field still set from set_category (no behavior change).
  assert.equal(signals[0].fields.autoCategory, 'Dining');
  assert.equal(signals[0].fields.appliedRuleId, 1);
  // Side-channel carries the non-scalar actions.
  assert.deepEqual(signals[0].ruleActions, {
    ruleId: 1,
    labelIds: [7, 9],
    alerts: [{ severity: 'warn', title: 'Watch this vendor' }],
  });
});

test('applyRuleStage: rule with only scalar-backed actions emits no side-channel', () => {
  const rule = baseRule({
    category: 'Dining',
    actions: [{ type: 'set_category', payload: { category: 'Dining' } }],
  });
  const signals = runApplyRuleStage({ merchantClean: 'NETFLIX', rules: [rule], txnDate: '2026-06-01' });
  assert.equal(signals[0].ruleActions, undefined);
});

test('applyRuleStage: no match emits nothing', () => {
  const rule = baseRule({ actions: [{ type: 'set_alert', payload: { severity: 'info' } }] });
  const signals = runApplyRuleStage({ merchantClean: 'STARBUCKS', rules: [rule], txnDate: '2026-06-01' });
  assert.deepEqual(signals, []);
});
