import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAutoAccept, AUTO_ACCEPT_THRESHOLD, AUTO_ACCEPT_MARGIN } from './autoAccept';

test('constants match the fixed policy', () => {
  assert.equal(AUTO_ACCEPT_THRESHOLD, 85);
  assert.equal(AUTO_ACCEPT_MARGIN, 10);
});

test('empty → false', () => {
  assert.equal(decideAutoAccept([]), false);
});

test('sole candidate ≥85 → true', () => {
  assert.equal(decideAutoAccept([90]), true);
});

test('sole candidate <85 → false', () => {
  assert.equal(decideAutoAccept([84]), false);
});

test('top ≥85 but margin not strictly >10 → false', () => {
  assert.equal(decideAutoAccept([90, 80]), false); // margin exactly 10
});

test('top ≥85 and margin >10 → true', () => {
  assert.equal(decideAutoAccept([90, 79]), true);
});
