import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_TOKEN_TTL_MS,
  TOKEN_SCOPES,
  hashScopedToken,
  isTokenExpired,
  isTokenFormat,
  mintTokenPlaintext,
  tokenExpiry,
} from './scopedToken';

const PREFIX = { audit: 'cfa_', reporting: 'cfr_', capture: 'cfc_' } as const;

for (const scope of TOKEN_SCOPES) {
  test(`mintTokenPlaintext(${scope}) is ${PREFIX[scope]} + 32 base64url chars and unique`, () => {
    const a = mintTokenPlaintext(scope);
    assert.match(a, new RegExp(`^${PREFIX[scope]}[A-Za-z0-9_-]{32}$`));
    assert.ok(isTokenFormat(scope, a));
    assert.notEqual(a, mintTokenPlaintext(scope));
  });

  test(`isTokenFormat(${scope}) refuses every other scope's prefix`, () => {
    for (const other of TOKEN_SCOPES) {
      if (other === scope) continue;
      assert.equal(isTokenFormat(scope, mintTokenPlaintext(other)), false, `${other} token passed ${scope}`);
    }
  });

  test(`isTokenFormat(${scope}) rejects wrong payload length`, () => {
    assert.equal(isTokenFormat(scope, PREFIX[scope] + 'a'.repeat(31)), false);
    assert.equal(isTokenFormat(scope, PREFIX[scope] + 'a'.repeat(33)), false);
    assert.equal(isTokenFormat(scope, ''), false);
  });
}

test('hashScopedToken is deterministic 64-char hex', () => {
  const t = mintTokenPlaintext('audit');
  assert.match(hashScopedToken(t), /^[0-9a-f]{64}$/);
  assert.equal(hashScopedToken(t), hashScopedToken(t));
});

test('only capture tokens get an expiry, 90 days out', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  assert.equal(tokenExpiry('capture', from)?.getTime(), from.getTime() + CAPTURE_TOKEN_TTL_MS);
  assert.equal(tokenExpiry('audit', from), null);
  assert.equal(tokenExpiry('reporting', from), null);
});

test('isTokenExpired: null never expires; past expires; future does not', () => {
  assert.equal(isTokenExpired(null), false);
  assert.equal(isTokenExpired(new Date(Date.now() - 1000)), true);
  assert.equal(isTokenExpired(new Date(Date.now() + CAPTURE_TOKEN_TTL_MS)), false);
});
