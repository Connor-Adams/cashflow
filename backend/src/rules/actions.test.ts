import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULE_ACTION_TYPES,
  SINGLETON_ACTION_TYPES,
  SETTABLE_TXN_TYPES,
  SCALAR_MIRRORED_ACTION_TYPES,
  preserveNonScalarActions,
  RISKY_TXN_TYPES,
  validateActions,
  deriveScalarsFromActions,
  type RuleAction,
} from './actions';

function ok(raw: unknown): RuleAction[] {
  const res = validateActions(raw, null);
  assert.equal(res.ok, true, `expected valid, got ${JSON.stringify(res)}`);
  return (res as { ok: true; actions: RuleAction[] }).actions;
}

function err(raw: unknown) {
  const res = validateActions(raw, null);
  assert.equal(res.ok, false, 'expected invalid');
  return res as { ok: false; error: string; message: string; index: number };
}

// ── set_txn_type ───────────────────────────────────────────────────────────
// Rules could set category/business/split/label/alert but never txn_type, so a
// recurring payer arriving under a second bank description (e.g. "Misc Payment
// ACME" alongside "Direct deposit from ACME") could not be taught to classify
// as income — it had to be hand-edited row by row.

test('set_txn_type is a registered action type', () => {
  assert.ok((RULE_ACTION_TYPES as readonly string[]).includes('set_txn_type'));
});

test('set_txn_type accepts a known transaction type', () => {
  const actions = ok([{ type: 'set_txn_type', payload: { txnType: 'income' } }]);
  assert.deepEqual(actions, [{ type: 'set_txn_type', payload: { txnType: 'income' } }]);
});

test('set_txn_type rejects a type outside the settable set', () => {
  const res = err([{ type: 'set_txn_type', payload: { txnType: 'not_a_type' } }]);
  assert.equal(res.error, 'INVALID_TXN_TYPE');
  assert.equal(res.index, 0);
  assert.match(res.message, /not_a_type/);
});

test('set_txn_type rejects a missing payload', () => {
  assert.equal(err([{ type: 'set_txn_type', payload: {} }]).error, 'INVALID_TXN_TYPE');
});

// One transaction has exactly one txn_type; two conflicting actions is not a
// merge, it is a mistake, and silently keeping the last would hide it.
test('set_txn_type may appear at most once', () => {
  assert.ok((SINGLETON_ACTION_TYPES as readonly string[]).includes('set_txn_type'));
  const res = err([
    { type: 'set_txn_type', payload: { txnType: 'income' } },
    { type: 'set_txn_type', payload: { txnType: 'fee' } },
  ]);
  assert.equal(res.error, 'DUPLICATE_ACTION');
  assert.equal(res.index, 1);
});

// The scalar columns mirror category/business/split only. txn_type has no rule
// column, so it must ride the actions list alone and leave the scalars alone.
test('set_txn_type does not leak into the mirrored scalar columns', () => {
  const scalars = deriveScalarsFromActions([
    { type: 'set_txn_type', payload: { txnType: 'income' } },
  ]);
  assert.equal(scalars.category, null);
  assert.equal(scalars.isBusiness, false);
});

test('set_txn_type composes with the other actions', () => {
  const actions = ok([
    { type: 'set_category', payload: { category: 'Salary' } },
    { type: 'set_txn_type', payload: { txnType: 'income' } },
  ]);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[1], { type: 'set_txn_type', payload: { txnType: 'income' } });
});

// txn_type drives isNonCategorical / isNonSpend, the Sankey, the dashboard and
// the T1 engine. The settable set is deliberately the full vocabulary (you must
// be able to mark something a dividend), but the destructive ones are named so
// the editor can warn rather than the API silently accepting them.
test('the settable set covers the vocabulary actually in use', () => {
  for (const t of ['income', 'purchase', 'transfer', 'payment', 'refund', 'reward', 'fee', 'interest', 'dividend', 'investment', 'unknown']) {
    assert.ok(SETTABLE_TXN_TYPES.has(t), `${t} must be settable`);
  }
});

test('the risky types are flagged and are a subset of the settable ones', () => {
  // Non-categorical (vanish from spend entirely) plus the ones that change
  // net-spend arithmetic.
  for (const t of ['transfer', 'investment', 'dividend', 'payment', 'refund', 'reward']) {
    assert.ok(RISKY_TXN_TYPES.has(t), `${t} must be flagged risky`);
  }
  assert.ok(!RISKY_TXN_TYPES.has('income'), 'income is not destructive');
  for (const t of RISKY_TXN_TYPES) {
    assert.ok(SETTABLE_TXN_TYPES.has(t), `${t} flagged risky but not settable`);
  }
});

// ── regression guards on the existing actions ──────────────────────────────

test('an unknown action type is still rejected', () => {
  assert.equal(err([{ type: 'set_nothing', payload: {} }]).error, 'INVALID_ACTION_TYPE');
});

test('set_category and set_split still validate as before', () => {
  assert.deepEqual(ok([{ type: 'set_category', payload: { category: 'Groceries' } }]), [
    { type: 'set_category', payload: { category: 'Groceries' } },
  ]);
  assert.equal(err([{ type: 'set_split', payload: { splitType: 'nope' } }]).error, 'INVALID_SPLIT');
});

// ── PATCH preservation ─────────────────────────────────────────────────────
// A scalar-only PATCH (e.g. "just change the category") rebuilds the actions
// list from the scalar columns and re-appends whatever it considers non-scalar.
// That filter used to be a literal allowlist of set_label/set_alert, so adding
// any new non-scalar action silently DROPPED it on the next scalar edit.

test('scalar-mirrored types are exactly the three with columns', () => {
  assert.deepEqual([...SCALAR_MIRRORED_ACTION_TYPES].sort(), [
    'set_business',
    'set_category',
    'set_split',
  ]);
});

test('preserveNonScalarActions keeps set_txn_type across a scalar-only edit', () => {
  const existing: RuleAction[] = [
    { type: 'set_category', payload: { category: 'Old' } },
    { type: 'set_txn_type', payload: { txnType: 'income' } },
    { type: 'set_label', payload: { labelId: 3 } },
  ];
  assert.deepEqual(preserveNonScalarActions(existing), [
    { type: 'set_txn_type', payload: { txnType: 'income' } },
    { type: 'set_label', payload: { labelId: 3 } },
  ]);
});

test('preserveNonScalarActions drops the scalar-mirrored ones (they get rederived)', () => {
  const existing: RuleAction[] = [
    { type: 'set_category', payload: { category: 'Old' } },
    { type: 'set_business', payload: { isBusiness: true } },
    { type: 'set_split', payload: { splitType: 'me', pctMe: null, pctPartner: null } },
  ];
  assert.deepEqual(preserveNonScalarActions(existing), []);
});

// The regression guard that matters: every action type is either rederived
// from scalars or preserved. Nothing may fall through the gap unnoticed.
test('every action type is either scalar-mirrored or preserved', () => {
  for (const type of RULE_ACTION_TYPES) {
    const mirrored = (SCALAR_MIRRORED_ACTION_TYPES as readonly string[]).includes(type);
    const preserved = preserveNonScalarActions([{ type, payload: {} } as unknown as RuleAction]).length === 1;
    assert.ok(mirrored !== preserved, `${type} must be exactly one of mirrored/preserved`);
  }
});
