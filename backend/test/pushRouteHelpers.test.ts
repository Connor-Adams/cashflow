/**
 * Unit tests for the pure validation helper in routes/push.ts (issue #651,
 * AC #4 validation logic). No DB needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscribeBody } from '../src/routes/push';

const valid = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'k', auth: 'a' },
};

test('accepts a valid body and normalizes userAgent', () => {
  const r = parseSubscribeBody({ ...valid, userAgent: 'Firefox' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.endpoint, 'https://fcm.googleapis.com/fcm/send/abc');
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

// SSRF allowlist (issue #855)
test('accepts each known push-service host', () => {
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://wns2-bn3p.notify.windows.com/w/?token=x',
    'https://web.push.apple.com/Qabc',
  ]) {
    assert.equal(
      parseSubscribeBody({ ...valid, endpoint }).ok,
      true,
      `should accept ${endpoint}`,
    );
  }
});

test('rejects an unrelated googleapis host not under fcm.googleapis.com', () => {
  const r = parseSubscribeBody({ ...valid, endpoint: 'https://android.googleapis.com/gcm/send/x' });
  assert.equal(r.ok, false);
});

test('rejects an internal/metadata endpoint (SSRF)', () => {
  for (const endpoint of [
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:9090/x',
    'https://localhost:9090/x',
    'http://127.0.0.1/x',
    'https://internal.corp/x',
  ]) {
    assert.equal(
      parseSubscribeBody({ ...valid, endpoint }).ok,
      false,
      `should reject ${endpoint}`,
    );
  }
});

test('rejects non-https even on an allowlisted host', () => {
  const r = parseSubscribeBody({ ...valid, endpoint: 'http://fcm.googleapis.com/fcm/send/x' });
  assert.equal(r.ok, false);
});

test('rejects a look-alike host that only suffix-matches without a dot boundary', () => {
  const r = parseSubscribeBody({ ...valid, endpoint: 'https://evilfcm.googleapis.com.attacker.test/x' });
  assert.equal(r.ok, false);
});

test('rejects a malformed endpoint URL', () => {
  const r = parseSubscribeBody({ ...valid, endpoint: 'not a url' });
  assert.equal(r.ok, false);
});
