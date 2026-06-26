import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_TOKEN_TTL_MS,
  captureTokenExpiry,
  isCaptureTokenExpired,
  isCaptureTokenFormat,
  mintCaptureTokenPlaintext,
} from './captureToken';

test('mintCaptureTokenPlaintext produces a well-formed token', () => {
  const t = mintCaptureTokenPlaintext();
  assert.ok(isCaptureTokenFormat(t));
});

test('captureTokenExpiry adds the TTL to the given instant', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const expiry = captureTokenExpiry(from);
  assert.equal(expiry.getTime(), from.getTime() + CAPTURE_TOKEN_TTL_MS);
});

test('isCaptureTokenExpired treats null as never-expiring', () => {
  assert.equal(isCaptureTokenExpired(null), false);
});

test('isCaptureTokenExpired is true for a past expiry', () => {
  const past = new Date(Date.now() - 1000);
  assert.equal(isCaptureTokenExpired(past), true);
});

test('isCaptureTokenExpired is false for a future expiry', () => {
  const future = new Date(Date.now() + CAPTURE_TOKEN_TTL_MS);
  assert.equal(isCaptureTokenExpired(future), false);
});

test('isCaptureTokenExpired uses the supplied now', () => {
  const expiresAt = new Date('2026-06-01T00:00:00Z');
  assert.equal(isCaptureTokenExpired(expiresAt, new Date('2026-05-31T23:59:59Z')), false);
  assert.equal(isCaptureTokenExpired(expiresAt, new Date('2026-06-01T00:00:01Z')), true);
});
