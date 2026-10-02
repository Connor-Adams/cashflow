import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeductiblePercent } from './deductiblePercent';

test('a declared percent wins', () => {
  assert.equal(resolveDeductiblePercent('0.5', true), 0.5);
  assert.equal(resolveDeductiblePercent(0.25, false), 0.25);
});

test('no metadata: business rows are fully deductible, others not at all', () => {
  assert.equal(resolveDeductiblePercent(null, true), 1);
  assert.equal(resolveDeductiblePercent(undefined, false), 0);
  assert.equal(resolveDeductiblePercent('', true), 1);
});

test('out-of-range values clamp to [0, 1]', () => {
  assert.equal(resolveDeductiblePercent('1.5', true), 1);
  assert.equal(resolveDeductiblePercent('-0.2', true), 0);
});
