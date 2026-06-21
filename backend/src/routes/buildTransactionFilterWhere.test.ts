import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import type { Request } from 'express';
import { buildTransactionFilterWhere } from './transactions';

// `buildTransactionFilterWhere` calls `visibleTransactionWhere(req)`, which
// reads `req.auth`. Stub a superadmin so the scope helper returns `{}` and
// the resulting `where` only contains keys this task adds.
function reqStub(): Request {
  return {
    headers: {},
    query: {},
    body: {},
    auth: {
      user: { globalRole: 'superadmin' },
      household: { id: 1 },
      role: 'owner',
    },
  } as unknown as Request;
}

test('autoConfidence exact match', () => {
  const w = buildTransactionFilterWhere(reqStub(), { autoConfidence: 'low' });
  assert.equal((w as Record<string, unknown>).autoConfidence, 'low');
});

test('autoSource (none) maps to IS NULL', () => {
  const w = buildTransactionFilterWhere(reqStub(), { autoSource: '(none)' });
  assert.deepEqual((w as Record<string, unknown>).autoSource, { [Op.is]: null });
});

test('txnType and merchantCanonical exact match', () => {
  const w = buildTransactionFilterWhere(reqStub(), {
    txnType: 'refund',
    merchantCanonical: 'Costco',
  });
  assert.equal((w as Record<string, unknown>).txnType, 'refund');
  assert.equal((w as Record<string, unknown>).merchantCanonical, 'Costco');
});

test('category (none) maps to IS NULL', () => {
  const w = buildTransactionFilterWhere(reqStub(), { category: '(none)' });
  assert.deepEqual((w as Record<string, unknown>).finalCategory, { [Op.is]: null });
});
