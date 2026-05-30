/**
 * Unit tests for the HMAC signed-URL helpers (issue #302, AC #6, #7, #13).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Provide a known secret so tests are deterministic.
process.env.EXPORTS_URL_SECRET = 'test-secret-12345';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let buildSignedParams: (...args: any[]) => { exp: string; sig: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let verifySignedParams: (...args: any[]) => any;

before(async () => {
  const mod = await import('../src/services/signedUrl.js');
  buildSignedParams = mod.buildSignedParams;
  verifySignedParams = mod.verifySignedParams;
});

test('buildSignedParams returns exp and sig', () => {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const { exp, sig } = buildSignedParams(1, 99, expiresAt);
  assert.ok(exp, 'exp should be set');
  assert.ok(sig, 'sig should be set');
  assert.ok(/^\d+$/.test(exp), 'exp should be numeric string');
  assert.ok(/^[0-9a-f]{64}$/.test(sig), 'sig should be 64-char hex');
});

test('verifySignedParams returns ok=true for valid params', () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const { exp, sig } = buildSignedParams(42, 7, expiresAt);
  const result = verifySignedParams(42, 7, exp, sig);
  assert.equal(result.ok, true);
});

test('verifySignedParams returns expired for past exp', () => {
  const expiresAt = new Date(Date.now() - 1000);
  const { exp, sig } = buildSignedParams(1, 1, expiresAt);
  const result = verifySignedParams(1, 1, exp, sig);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'expired');
  }
});

test('verifySignedParams returns invalid_signature for wrong sig', () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const { exp } = buildSignedParams(1, 1, expiresAt);
  const result = verifySignedParams(
    1,
    1,
    exp,
    'badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad1234',
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'invalid_signature');
  }
});

test('verifySignedParams binds to userId — different user cannot reuse URL (AC #13)', () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const { exp, sig } = buildSignedParams(5, 100, expiresAt);
  const result = verifySignedParams(5, 999, exp, sig);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'invalid_signature');
  }
});

test('verifySignedParams binds to exportId — different export cannot reuse URL', () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const { exp, sig } = buildSignedParams(10, 50, expiresAt);
  const result = verifySignedParams(99, 50, exp, sig);
  assert.equal(result.ok, false);
});

test('verifySignedParams returns invalid_signature for missing params', () => {
  const r1 = verifySignedParams(1, 1, undefined, undefined);
  assert.equal(r1.ok, false);

  const r2 = verifySignedParams(1, 1, '12345', undefined);
  assert.equal(r2.ok, false);

  const r3 = verifySignedParams(1, 1, undefined, 'abc');
  assert.equal(r3.ok, false);
});
