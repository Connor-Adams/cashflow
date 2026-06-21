import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintAuditTokenPlaintext,
  hashAuditToken,
  isAuditTokenFormat,
  maskAuditToken,
} from './auditToken';

test('mintAuditTokenPlaintext returns cfa_ prefix + 32 base64url chars', () => {
  const token = mintAuditTokenPlaintext();
  assert.match(token, /^cfa_[A-Za-z0-9_-]{32}$/);
});

test('mintAuditTokenPlaintext generates unique values', () => {
  const a = mintAuditTokenPlaintext();
  const b = mintAuditTokenPlaintext();
  assert.notEqual(a, b);
});

test('hashAuditToken returns a 64-char hex string', () => {
  const hash = hashAuditToken('cfa_sometoken');
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('hashAuditToken is deterministic', () => {
  const t = 'cfa_abc123';
  assert.equal(hashAuditToken(t), hashAuditToken(t));
});

test('isAuditTokenFormat accepts valid cfa_ tokens', () => {
  const token = mintAuditTokenPlaintext();
  assert.equal(isAuditTokenFormat(token), true);
});

test('isAuditTokenFormat rejects cfc_ tokens', () => {
  assert.equal(isAuditTokenFormat('cfc_' + 'a'.repeat(32)), false);
});

test('isAuditTokenFormat rejects cfr_ tokens', () => {
  assert.equal(isAuditTokenFormat('cfr_' + 'a'.repeat(32)), false);
});

test('isAuditTokenFormat rejects tokens with wrong payload length', () => {
  assert.equal(isAuditTokenFormat('cfa_' + 'a'.repeat(31)), false);
  assert.equal(isAuditTokenFormat('cfa_' + 'a'.repeat(33)), false);
});

test('maskAuditToken masks the middle', () => {
  const token = mintAuditTokenPlaintext();
  const masked = maskAuditToken(token);
  assert.ok(masked.includes('…'), 'contains ellipsis');
  assert.ok(masked.length < token.length, 'shorter than original');
});
