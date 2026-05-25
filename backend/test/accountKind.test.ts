import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountKind } from '../src/networth/accountKind';

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
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => { warnings.push(msg); };
  try {
    assert.equal(accountKind('mystery'), 'asset');
    assert.ok(
      warnings.some((w) => w.includes('[networth] unknown accountType: mystery')),
      `expected a warn about "mystery", got: ${JSON.stringify(warnings)}`
    );
  } finally {
    console.warn = originalWarn;
  }
});
