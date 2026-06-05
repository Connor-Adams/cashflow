/**
 * Unit tests for feedback submission validation (issue #295).
 * Pure function — no DB, no HTTP. Covers the category enum and body length
 * rules that back AC#3 (INVALID_CATEGORY) and AC#4 (BODY_TOO_SHORT/LONG).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFeedback, FEEDBACK_CATEGORIES } from './validate.js';

test('accepts a valid bug submission', () => {
  const v = validateFeedback({ category: 'bug', body: 'Button is broken' });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.value.category, 'bug');
    assert.equal(v.value.body, 'Button is broken');
  }
});

test('defaults category to "other" when omitted', () => {
  const v = validateFeedback({ body: 'hello there' });
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.value.category, 'other');
});

test('defaults category to "other" when empty string', () => {
  const v = validateFeedback({ category: '', body: 'hello there' });
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.value.category, 'other');
});

test('rejects an unknown category with INVALID_CATEGORY', () => {
  const v = validateFeedback({ category: 'spam', body: 'hello there' });
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.status, 400);
    assert.equal(v.error, 'INVALID_CATEGORY');
  }
});

test('rejects a body under 5 chars after trim with BODY_TOO_SHORT', () => {
  const v = validateFeedback({ category: 'bug', body: '   hi   ' });
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.status, 400);
    assert.equal(v.error, 'BODY_TOO_SHORT');
  }
});

test('rejects a missing body with BODY_TOO_SHORT', () => {
  const v = validateFeedback({ category: 'bug' });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.error, 'BODY_TOO_SHORT');
});

test('rejects a body over 2000 chars with BODY_TOO_LONG', () => {
  const v = validateFeedback({ category: 'bug', body: 'a'.repeat(2001) });
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.status, 400);
    assert.equal(v.error, 'BODY_TOO_LONG');
  }
});

test('accepts a body of exactly 2000 chars', () => {
  const v = validateFeedback({ category: 'bug', body: 'a'.repeat(2000) });
  assert.equal(v.ok, true);
});

test('trims body and clamps optional currentPath/appVersion length', () => {
  const v = validateFeedback({
    category: 'feature',
    body: '  please add dark mode  ',
    currentPath: '/x'.repeat(400),
    appVersion: 'v'.repeat(100),
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.value.body, 'please add dark mode');
    assert.equal(v.value.currentPath?.length, 512);
    assert.equal(v.value.appVersion?.length, 64);
  }
});

test('nulls out non-string optional fields', () => {
  const v = validateFeedback({ category: 'other', body: 'this is fine', currentPath: 42 });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.value.currentPath, null);
    assert.equal(v.value.appVersion, null);
  }
});

test('exposes the four categories in order', () => {
  assert.deepEqual([...FEEDBACK_CATEGORIES], ['bug', 'feature', 'confusing', 'other']);
});
