import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runApplyRuleStage } from './applyRuleStage';
import type { RuleRow } from '../applyRules';

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
    txnDate: '2026-01-01',
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
    txnDate: '2026-01-01',
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
    txnDate: '2026-01-01',
  });
  assert.equal(signals.length, 0);
});

// ── set_txn_type ───────────────────────────────────────────────────────────
// txnType is already a first-class SignalFields key written by all three
// persist paths (import, statement commit, backfill), so the action belongs in
// `fields` — not the ruleActions side-channel, which exists for set_label /
// set_alert because those write to OTHER tables.

test('set_txn_type action lands on fields.txnType', () => {
  const signals = runApplyRuleStage({
    merchantClean: 'CDG LABS INC',
    rules: [
      rule({
        id: 42,
        merchantPattern: 'CDG LABS',
        actions: [{ type: 'set_txn_type', payload: { txnType: 'income' } }],
      }),
    ],
    txnDate: '2026-07-31',
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].fields.txnType, 'income');
  assert.equal(signals[0].fields.appliedRuleId, 42);
});

test('a rule without set_txn_type leaves txnType unclaimed', () => {
  const signals = runApplyRuleStage({
    merchantClean: 'NETFLIX',
    rules: [rule({ id: 8, merchantPattern: 'NETFLIX', category: 'Subscriptions' })],
    txnDate: '2026-01-01',
  });
  assert.equal(signals.length, 1);
  // Not `undefined`-by-accident: leaving the key off lets the lower-precedence
  // type-detect stage win, which is the whole point of not claiming it.
  assert.ok(!('txnType' in signals[0].fields));
});

test('set_txn_type composes with the scalar effects and the side-channel actions', () => {
  const signals = runApplyRuleStage({
    merchantClean: 'CDG LABS INC',
    rules: [
      rule({
        id: 9,
        merchantPattern: 'CDG LABS',
        category: 'Salary',
        actions: [
          { type: 'set_category', payload: { category: 'Salary' } },
          { type: 'set_txn_type', payload: { txnType: 'income' } },
          { type: 'set_label', payload: { labelId: 3 } },
        ],
      }),
    ],
    txnDate: '2026-07-31',
  });
  assert.equal(signals[0].fields.txnType, 'income');
  assert.equal(signals[0].fields.autoCategory, 'Salary');
  assert.deepEqual(signals[0].ruleActions?.labelIds, [3]);
});
