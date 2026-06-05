import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountKind } from './accountKind';

test('accountKind: checking is asset', () => {
  assert.equal(accountKind('checking'), 'asset');
});

test('accountKind: savings is asset', () => {
  assert.equal(accountKind('savings'), 'asset');
});

test('accountKind: investment is asset', () => {
  assert.equal(accountKind('investment'), 'asset');
});

test('accountKind: cash is asset', () => {
  assert.equal(accountKind('cash'), 'asset');
});

test('accountKind: credit_card is liability', () => {
  assert.equal(accountKind('credit_card'), 'liability');
});

test('accountKind: loan is liability', () => {
  assert.equal(accountKind('loan'), 'liability');
});

test('accountKind: mortgage is liability', () => {
  assert.equal(accountKind('mortgage'), 'liability');
});

test('accountKind: unknown defaults to asset and warns', () => {
  const warns: Array<{ fields: Record<string, unknown>; msg: string }> = [];
  const stubLogger = {
    warn: (fields: Record<string, unknown>, msg: string) => warns.push({ fields, msg }),
  };
  const result = accountKind('mystery', stubLogger);
  assert.equal(result, 'asset');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].msg, 'unknown_account_type_default_asset');
  assert.equal(warns[0].fields.accountType, 'mystery');
  assert.equal(warns[0].fields.module, 'networth');
});
