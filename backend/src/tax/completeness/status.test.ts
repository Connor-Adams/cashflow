/**
 * Worst-wins, and the affirmative-complete line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worstStatus } from './status';
import type { CompletenessItem } from './types';

const item = (severity: CompletenessItem['severity']): CompletenessItem => ({
  kind: 'k', severity, title: 't', detail: 'd',
  amount: null, taxEstimate: null,
  fix: { surface: 'classify', label: 'l' }, references: [],
});

test('no items is complete', () => {
  assert.equal(worstStatus([]), 'complete');
});

test('gaps alone is gaps', () => {
  assert.equal(worstStatus([item('gap'), item('gap')]), 'gaps');
});

test('one blocker among many gaps is blocked', () => {
  assert.equal(worstStatus([item('gap'), item('blocker'), item('gap')]), 'blocked');
});

test('blockers alone is blocked', () => {
  assert.equal(worstStatus([item('blocker')]), 'blocked');
});
