import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PATTERN_LENGTH,
  MAX_HAYSTACK_LENGTH,
  validateUserPattern,
  safeRegexTest,
} from './safeRegex';

test('validateUserPattern accepts a normal pattern and returns a usable RegExp', () => {
  const r = validateUserPattern('amazon|amzn', 'i');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.re.test('AMAZON MARKETPLACE'));
    assert.ok(!r.re.test('walmart'));
  }
});

test('validateUserPattern rejects an over-long pattern', () => {
  const long = 'a'.repeat(MAX_PATTERN_LENGTH + 1);
  const r = validateUserPattern(long, 'i');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error, 'PATTERN_TOO_LONG');
  }
});

test('validateUserPattern accepts a pattern exactly at the length limit', () => {
  const atLimit = 'a'.repeat(MAX_PATTERN_LENGTH);
  const r = validateUserPattern(atLimit, 'i');
  assert.equal(r.ok, true);
});

test('validateUserPattern rejects nested-quantifier ReDoS pattern (a+)+', () => {
  const r = validateUserPattern('(a+)+$', 'i');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error, 'UNSAFE_PATTERN');
  }
});

test('validateUserPattern rejects (a*)* and (.*)* style nested stars', () => {
  for (const p of ['(a*)*', '(.*)*', '([a-z]+)+', '(\\w+)*$']) {
    const r = validateUserPattern(p, 'i');
    assert.equal(r.ok, false, `expected ${p} to be rejected`);
    if (!r.ok) assert.equal(r.error, 'UNSAFE_PATTERN');
  }
});

test('validateUserPattern rejects alternation-with-overlap ReDoS (a|a)*', () => {
  const r = validateUserPattern('(a|a)*$', 'i');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'UNSAFE_PATTERN');
});

test('validateUserPattern rejects a syntactically invalid pattern', () => {
  const r = validateUserPattern('(unterminated', 'i');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'INVALID_PATTERN');
});

test('validateUserPattern rejects empty pattern', () => {
  const r = validateUserPattern('', 'i');
  assert.equal(r.ok, false);
});

test('safeRegexTest evaluates a normal input', () => {
  const r = validateUserPattern('coffee', 'i');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(safeRegexTest(r.re, 'BLUE BOTTLE COFFEE'));
    assert.ok(!safeRegexTest(r.re, 'tea'));
  }
});

test('safeRegexTest truncates over-long input so it never matches beyond the cap', () => {
  // Anchored match at a position past the cap must not be found.
  const r = validateUserPattern('needle$', 'i');
  assert.equal(r.ok, true);
  if (r.ok) {
    const hay = 'x'.repeat(MAX_HAYSTACK_LENGTH + 50) + 'needle';
    assert.equal(safeRegexTest(r.re, hay), false);
  }
});

test('validateUserPattern + safeRegexTest reject the classic evil pattern without hanging', () => {
  // Even if a future change let an evil pattern through validation, the
  // bounded haystack keeps the worst-case input small. Here we assert the
  // validator rejects it up front so .test() is never reached.
  const evil = '(a+)+$';
  const evilInput = 'a'.repeat(40) + '!';
  const r = validateUserPattern(evil, 'i');
  assert.equal(r.ok, false);
  // Sanity: a benign compiled regex on a bounded input returns promptly.
  const safe = validateUserPattern('a+', 'i');
  assert.equal(safe.ok, true);
  if (safe.ok) {
    const start = Date.now();
    safeRegexTest(safe.re, evilInput);
    assert.ok(Date.now() - start < 50);
  }
});
