/**
 * Unit tests for audit-token helpers (#387).
 * Pure-function tests — no DB required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintAuditTokenPlaintext,
  hashAuditToken,
  isAuditTokenFormat,
  maskAuditToken,
} from '../src/auth/auditToken.js';

test('mintAuditTokenPlaintext returns cfa_ prefixed token of correct format', () => {
  const token = mintAuditTokenPlaintext();
  assert.match(token, /^cfa_[A-Za-z0-9_-]{32}$/);
});

test('mintAuditTokenPlaintext returns unique tokens each call', () => {
  const a = mintAuditTokenPlaintext();
  const b = mintAuditTokenPlaintext();
  assert.notEqual(a, b);
});

test('hashAuditToken returns 64-char hex string', () => {
  const hash = hashAuditToken('cfa_testtoken');
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('hashAuditToken is deterministic', () => {
  const plaintext = 'cfa_testvalue';
  assert.equal(hashAuditToken(plaintext), hashAuditToken(plaintext));
});

test('hashAuditToken produces different output for different inputs', () => {
  assert.notEqual(hashAuditToken('cfa_aaa'), hashAuditToken('cfa_bbb'));
});

test('isAuditTokenFormat accepts valid cfa_ tokens', () => {
  assert.ok(isAuditTokenFormat('cfa_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234_'));
  assert.ok(isAuditTokenFormat(mintAuditTokenPlaintext()));
});

test('isAuditTokenFormat rejects wrong prefix', () => {
  assert.equal(isAuditTokenFormat('cfc_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234_'), false);
  assert.equal(isAuditTokenFormat('xxx_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234_'), false);
});

test('isAuditTokenFormat rejects too-short suffix', () => {
  assert.equal(isAuditTokenFormat('cfa_short'), false);
});

test('isAuditTokenFormat rejects too-long suffix', () => {
  assert.equal(isAuditTokenFormat('cfa_' + 'a'.repeat(33)), false);
});

test('isAuditTokenFormat rejects empty string', () => {
  assert.equal(isAuditTokenFormat(''), false);
});

test('maskAuditToken shows first 7 chars and last 3', () => {
  const token = 'cfa_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123';
  const masked = maskAuditToken(token);
  assert.equal(masked.slice(0, 7), 'cfa_aBc');
  assert.equal(masked.slice(-3), '123');
  assert.ok(masked.includes('…'));
});

test('maskAuditToken returns short values unchanged', () => {
  assert.equal(maskAuditToken('short'), 'short');
});
