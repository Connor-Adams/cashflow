/**
 * Unit tests for the pure validation helper in routes/push.ts (issue #651,
 * AC #4 validation logic). No DB needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscribeBody } from '../src/routes/push';

const valid = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'k', auth: 'a' },
};

test('accepts a valid body and normalizes userAgent', () => {
  const r = parseSubscribeBody({ ...valid, userAgent: 'Firefox' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.endpoint, 'https://push.example/abc');
    assert.equal(r.value.p256dh, 'k');
    assert.equal(r.value.auth, 'a');
    assert.equal(r.value.userAgent, 'Firefox');
  }
});

test('userAgent defaults to null when missing/blank', () => {
  const r = parseSubscribeBody(valid);
  assert.ok(r.ok && r.value.userAgent === null);
  const r2 = parseSubscribeBody({ ...valid, userAgent: '   ' });
  assert.ok(r2.ok && r2.value.userAgent === null);
});

test('rejects missing endpoint', () => {
  const r = parseSubscribeBody({ keys: { p256dh: 'k', auth: 'a' } });
  assert.equal(r.ok, false);
});

test('rejects blank endpoint', () => {
  const r = parseSubscribeBody({ ...valid, endpoint: '   ' });
  assert.equal(r.ok, false);
});

test('rejects missing keys', () => {
  const r = parseSubscribeBody({ endpoint: valid.endpoint });
  assert.equal(r.ok, false);
});

test('rejects missing p256dh', () => {
  const r = parseSubscribeBody({ endpoint: valid.endpoint, keys: { auth: 'a' } });
  assert.equal(r.ok, false);
});

test('rejects missing auth', () => {
  const r = parseSubscribeBody({ endpoint: valid.endpoint, keys: { p256dh: 'k' } });
  assert.equal(r.ok, false);
});

test('rejects non-object body', () => {
  assert.equal(parseSubscribeBody(null).ok, false);
  assert.equal(parseSubscribeBody('nope').ok, false);
});
