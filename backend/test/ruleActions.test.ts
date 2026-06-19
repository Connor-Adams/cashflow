import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveActionsFromScalars,
  deriveScalarsFromActions,
  validateActions,
  RULE_ACTION_FIRED_TYPE,
  type RuleAction,
} from '../src/rules/actions';

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
