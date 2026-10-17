import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULE_ACTION_TYPES,
  RULE_ACTION_FIRED_TYPE,
  SINGLETON_ACTION_TYPES,
  preserveNonScalarActions,
  validateActions,
  deriveActionsFromScalars,
  deriveScalarsFromActions,
  type RuleAction,
} from './actions';
import { TXN_TYPE_VALUES, RISKY_TXN_TYPE_VALUES } from '@cashflow/shared';
import { NON_SPEND_TXN_TYPES } from '../summary/classifyTransactionFlow';

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
test('every value in the shared vocabulary validates', () => {
  for (const t of TXN_TYPE_VALUES) {
    const actions = ok([{ type: 'set_txn_type', payload: { txnType: t } }]);
    assert.deepEqual(actions, [{ type: 'set_txn_type', payload: { txnType: t } }]);
  }
});

test('every risky type is itself settable, and income is not one of them', () => {
  for (const t of RISKY_TXN_TYPE_VALUES) {
    assert.equal(validateActions([{ type: 'set_txn_type', payload: { txnType: t } }], null).ok, true);
  }
  assert.ok(
    !(RISKY_TXN_TYPE_VALUES as readonly string[]).includes('income'),
    'income is not destructive',
  );
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
    const mirrored = ['set_category', 'set_business', 'set_split'].includes(type);
    const preserved = preserveNonScalarActions([{ type, payload: {} } as unknown as RuleAction]).length === 1;
    assert.ok(mirrored !== preserved, `${type} must be exactly one of mirrored/preserved`);
  }
});

// ── one vocabulary, two consumers ──────────────────────────────────────────
// The editor renders these lists and warns on the risky ones. It used to hold
// a hand-copied duplicate, which made the backend constants decorative and let
// the two drift — the exact failure the derivation was supposed to prevent.
// The shared module is now the single runtime source; these assertions are what
// keep it honest against the backend's authoritative definitions.

test('the shared risky list matches NON_SPEND_TXN_TYPES minus income', () => {
  const authoritative = [...NON_SPEND_TXN_TYPES].filter((t) => t !== 'income').sort();
  assert.deepEqual([...RISKY_TXN_TYPE_VALUES].sort(), authoritative);
});

// ── scalars ⇄ actions derivation and validateActions error codes ────────────
// Merged in from the pre-colocation holdover backend/test/ruleActions.test.ts,
// which sat in neither suite until commit 8a6211a6.

test('deriveActionsFromScalars: default scalar-only rule yields no actions', () => {
  const actions = deriveActionsFromScalars({
    category: null,
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  });
  assert.deepEqual(actions, []);
});

test('deriveActionsFromScalars: category + business + split', () => {
  const actions = deriveActionsFromScalars({
    category: 'Groceries',
    isBusiness: true,
    splitType: 'shared',
    pctMe: '0.5000',
    pctPartner: '0.5000',
  });
  assert.deepEqual(actions, [
    { type: 'set_category', payload: { category: 'Groceries' } },
    { type: 'set_business', payload: { isBusiness: true } },
    { type: 'set_split', payload: { splitType: 'shared', pctMe: '0.5000', pctPartner: '0.5000' } },
  ]);
});

test('deriveActionsFromScalars: split percentages alone trigger set_split even on me', () => {
  const actions = deriveActionsFromScalars({
    category: null,
    isBusiness: false,
    splitType: 'me',
    pctMe: '1.0000',
    pctPartner: null,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'set_split');
});

test('deriveScalarsFromActions: inverse of derive, baseline for missing types', () => {
  const scalars = deriveScalarsFromActions([
    { type: 'set_category', payload: { category: 'Dining' } },
    { type: 'set_alert', payload: { severity: 'warn' } },
  ]);
  assert.deepEqual(scalars, {
    category: 'Dining',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  });
});

test('derive round-trips scalars -> actions -> scalars', () => {
  const original = {
    category: 'Travel',
    isBusiness: true,
    splitType: 'partner',
    pctMe: '0.0000',
    pctPartner: '1.0000',
  };
  const back = deriveScalarsFromActions(deriveActionsFromScalars(original));
  assert.deepEqual(back, original);
});

test('validateActions: rejects unknown action type', () => {
  const r = validateActions([{ type: 'set_frobnicate', payload: {} }], null);
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, 'INVALID_ACTION_TYPE');
});

test('validateActions: rejects invalid split type and bad percentages', () => {
  const badType = validateActions([{ type: 'set_split', payload: { splitType: 'thirds' } }], null);
  assert.equal((badType as { error: string }).error, 'INVALID_SPLIT');

  const badPct = validateActions(
    [{ type: 'set_split', payload: { splitType: 'shared', pctMe: '0.7', pctPartner: '0.7' } }],
    null,
  );
  assert.equal((badPct as { error: string }).error, 'INVALID_SPLIT');
});

test('validateActions: rejects out-of-household labelId', () => {
  const r = validateActions([{ type: 'set_label', payload: { labelId: 99 } }], new Set([1, 2]));
  assert.equal((r as { error: string }).error, 'INVALID_TAG');

  const ok = validateActions([{ type: 'set_label', payload: { labelId: 2 } }], new Set([1, 2]));
  assert.equal(ok.ok, true);
});

test('validateActions: rejects invalid alert severity', () => {
  const r = validateActions([{ type: 'set_alert', payload: { severity: 'meh' } }], null);
  assert.equal((r as { error: string }).error, 'INVALID_ALERT');
});

test('validateActions: rejects duplicate singleton actions', () => {
  const r = validateActions(
    [
      { type: 'set_category', payload: { category: 'A' } },
      { type: 'set_category', payload: { category: 'B' } },
    ],
    null,
  );
  assert.equal((r as { error: string }).error, 'DUPLICATE_ACTION');
});

test('validateActions: allows multiple set_label and set_alert', () => {
  const r = validateActions(
    [
      { type: 'set_label', payload: { labelId: 1 } },
      { type: 'set_label', payload: { labelId: 2 } },
      { type: 'set_alert', payload: { severity: 'info' } },
      { type: 'set_alert', payload: { severity: 'critical', title: 'Hey' } },
    ],
    new Set([1, 2]),
  );
  assert.equal(r.ok, true);
  assert.equal((r as { actions: RuleAction[] }).actions.length, 4);
});

test('RULE_ACTION_FIRED_TYPE constant', () => {
  assert.equal(RULE_ACTION_FIRED_TYPE, 'rule_action_fired');
});
