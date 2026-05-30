import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintAuditTokenPlaintext,
  hashAuditToken,
  isAuditTokenFormat,
  maskAuditToken,
} from '../../src/auth/auditToken.js';

test('mintAuditTokenPlaintext returns cfa_ prefixed 36-char string', () => {
  const t = mintAuditTokenPlaintext();
  assert.match(t, /^cfa_[A-Za-z0-9_-]{32}$/);
  assert.equal(t.length, 36);
});

test('mintAuditTokenPlaintext is unique across calls', () => {
  const a = mintAuditTokenPlaintext();
  const b = mintAuditTokenPlaintext();
  assert.notEqual(a, b);
});

test('hashAuditToken returns 64-char hex', () => {
  const t = mintAuditTokenPlaintext();
  const h = hashAuditToken(t);
  assert.match(h, /^[a-f0-9]{64}$/);
});

test('hashAuditToken is deterministic', () => {
  const t = mintAuditTokenPlaintext();
  assert.equal(hashAuditToken(t), hashAuditToken(t));
});

test('isAuditTokenFormat accepts well-formed token', () => {
  assert.equal(isAuditTokenFormat(mintAuditTokenPlaintext()), true);
});

test('isAuditTokenFormat rejects capture token prefix', () => {
  assert.equal(isAuditTokenFormat('cfc_' + 'A'.repeat(32)), false);
});

test('isAuditTokenFormat rejects short token', () => {
  assert.equal(isAuditTokenFormat('cfa_short'), false);
});

test('maskAuditToken hides middle', () => {
  const t = 'cfa_' + 'A'.repeat(32);
  const m = maskAuditToken(t);
  assert.equal(m.startsWith('cfa_AAA'), true);
  assert.equal(m.endsWith('AAA'), true);
  assert.ok(m.includes('…'));
});
