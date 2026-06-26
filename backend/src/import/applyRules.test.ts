import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBestRule, type RuleRow } from './applyRules';

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
      effectiveFrom: null,
      effectiveTo: null,
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
      effectiveFrom: null,
      effectiveTo: null,
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
      effectiveFrom: null,
      effectiveTo: null,
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
      effectiveFrom: null,
      effectiveTo: null,
    },
  ];
  const { rule, ambiguous } = findBestRule(rules, 'XY');
  assert.equal(ambiguous, true);
  assert.equal(rule, null);
});

function makeRule(over: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 1,
    merchantPattern: 'GROCER',
    priority: 1,
    matchKind: 'substring',
    category: null,
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
    ...over,
  };
}

test('findBestRule excludes rules whose effective_from is after txnDate', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, effectiveFrom: '2026-12-01' }),
  ];
  const { rule } = findBestRule(rules, 'GROCER', '2026-11-30');
  assert.equal(rule, null);
});

test('findBestRule includes rules with effective_from on or before txnDate', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, effectiveFrom: '2026-12-01' }),
  ];
  const { rule } = findBestRule(rules, 'GROCER', '2026-12-01');
  assert.equal(rule?.id, 1);
});

test('findBestRule excludes rules whose effective_to equals txnDate (exclusive upper bound)', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, effectiveTo: '2026-12-01' }),
  ];
  const { rule } = findBestRule(rules, 'GROCER', '2026-12-01');
  assert.equal(rule, null);
});

test('findBestRule includes rules whose effective_to is after txnDate', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, effectiveTo: '2026-12-02' }),
  ];
  const { rule } = findBestRule(rules, 'GROCER', '2026-12-01');
  assert.equal(rule?.id, 1);
});

test('findBestRule with null effective bounds matches any txnDate', () => {
  const rules: RuleRow[] = [makeRule({ id: 1 })];
  const a = findBestRule(rules, 'GROCER', '1999-01-01').rule;
  const b = findBestRule(rules, 'GROCER', '2099-01-01').rule;
  assert.equal(a?.id, 1);
  assert.equal(b?.id, 1);
});

test('findBestRule omits date filter when txnDate is undefined (backwards-compatible)', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, effectiveFrom: '2026-12-01' }),
  ];
  const { rule } = findBestRule(rules, 'GROCER');
  assert.equal(rule?.id, 1);
});

test('findBestRule picks the date-scoped rule when both a dateless and a date-scoped rule match', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, priority: 5, effectiveFrom: null, pctMe: '1.0000' }),
    makeRule({ id: 2, priority: 5, effectiveFrom: '2026-12-01', pctMe: '0.6000' }),
  ];
  // Tie-breaker stays as it is in the existing implementation (priority, then
  // pattern length, then id). With same priority and same pattern length, the
  // higher id wins. Both are in-scope on this date.
  const { rule, ambiguous } = findBestRule(rules, 'GROCER', '2026-12-15');
  // Both same priority + same pattern length → ambiguous in the existing logic.
  assert.equal(ambiguous, true);
  assert.equal(rule, null);
});

test('findBestRule resolves cleanly when only the date-scoped rule is in scope', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, priority: 5, effectiveFrom: '2027-01-01', pctMe: '1.0000' }),
    makeRule({ id: 2, priority: 5, effectiveFrom: '2026-12-01', pctMe: '0.6000' }),
  ];
  const { rule, ambiguous } = findBestRule(rules, 'GROCER', '2026-12-15');
  assert.equal(ambiguous, false);
  assert.equal(rule?.id, 2);
});

test('findBestRule does not block on a catastrophic-backtracking regex rule (#818)', () => {
  // A stored regex rule with an evil pattern must NOT hang the loop; the safe
  // wrapper rejects it so it simply does not match.
  const rules: RuleRow[] = [
    {
      id: 1,
      merchantPattern: '(a+)+$',
      priority: 1,
      matchKind: 'regex',
      category: 'Bad',
      isBusiness: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
      effectiveFrom: null,
      effectiveTo: null,
    },
  ];
  const evilInput = 'a'.repeat(40) + '!';
  const start = Date.now();
  const { rule } = findBestRule(rules, evilInput);
  assert.ok(Date.now() - start < 100, 'evaluation must return promptly');
  assert.equal(rule, null, 'evil pattern is rejected, so no rule matches');
});

test('findBestRule still honors a normal regex rule (#818 regression)', () => {
  const rules: RuleRow[] = [
    {
      id: 1,
      merchantPattern: 'amazon|amzn',
      priority: 1,
      matchKind: 'regex',
      category: 'Shopping',
      isBusiness: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
      effectiveFrom: null,
      effectiveTo: null,
    },
  ];
  const { rule } = findBestRule(rules, 'amzn mktp ca');
  assert.equal(rule?.id, 1);
});
