/**
 * Unit tests for buildTransactionFilterWhere — the helper that maps incoming
 * query/body fields to a Sequelize `where` clause. Exercised here without a
 * database so we can pin down quirky behaviors (NaN passthrough, ids parsing,
 * date-range composition) the integration suite doesn't isolate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import type { Request } from 'express';
import { buildTransactionFilterWhere } from '../src/routes/transactions';

// `buildTransactionFilterWhere` calls `visibleTransactionWhere(req)`, which
// reads `req.auth`. To keep these tests focused on the field-mapping logic
// (not the scope clause), we stub a superadmin auth — the scope helper then
// returns `{}` and the resulting `where` only contains keys our function
// added.
function fakeReq(): Request {
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

test('buildTransactionFilterWhere: empty source under superadmin scope is empty', () => {
  // Superadmin scope returns {}, so with no filter fields the where is empty.
  // This pins the "no-filter no-scope-keys" baseline that the assertions
  // below build on.
  const where = buildTransactionFilterWhere(fakeReq(), {});
  assert.deepEqual(where, {});
});

test('buildTransactionFilterWhere: ids string with all-invalid entries collapses to id=-1', () => {
  const where = buildTransactionFilterWhere(fakeReq(), { ids: 'abc,xyz,---' });
  assert.equal(where.id, -1);
});

test('buildTransactionFilterWhere: ids string with mixed valid/invalid keeps only valid positive ints', () => {
  const where = buildTransactionFilterWhere(fakeReq(), { ids: '1,abc,2' });
  assert.deepEqual(where.id, [1, 2]);
});

test('buildTransactionFilterWhere: ids string with all valid ints round-trips', () => {
  const where = buildTransactionFilterWhere(fakeReq(), { ids: '10,20,30' });
  assert.deepEqual(where.id, [10, 20, 30]);
});

test('buildTransactionFilterWhere: empty ids string is ignored (no id clause)', () => {
  const where = buildTransactionFilterWhere(fakeReq(), { ids: '' });
  assert.ok(!('id' in where));
});

test('buildTransactionFilterWhere: reviewFlag accepts string "true" and boolean true', () => {
  const a = buildTransactionFilterWhere(fakeReq(), { reviewFlag: 'true' });
  assert.equal(a.reviewFlag, true);
  const b = buildTransactionFilterWhere(fakeReq(), { reviewFlag: true });
  assert.equal(b.reviewFlag, true);
});

test('buildTransactionFilterWhere: reviewFlag accepts string "false" and boolean false', () => {
  const a = buildTransactionFilterWhere(fakeReq(), { reviewFlag: 'false' });
  assert.equal(a.reviewFlag, false);
  const b = buildTransactionFilterWhere(fakeReq(), { reviewFlag: false });
  assert.equal(b.reviewFlag, false);
});

test('buildTransactionFilterWhere: accountId="notanumber" passes NaN through (Sequelize returns empty)', () => {
  // Documented quirk: parseInt('notanumber', 10) → NaN; we surface it as the
  // where filter so the downstream query naturally returns no rows. The
  // alternative would be a 400 from the route, but the design plan says
  // this passes through.
  const where = buildTransactionFilterWhere(fakeReq(), { accountId: 'notanumber' });
  assert.equal(Number.isNaN(where.accountId), true);
});

test('buildTransactionFilterWhere: empty dateFrom is ignored (falsy guard)', () => {
  const where = buildTransactionFilterWhere(fakeReq(), { dateFrom: '' });
  assert.ok(!('date' in where));
});

test('buildTransactionFilterWhere: both dateFrom and dateTo populate Op.gte and Op.lte', () => {
  const where = buildTransactionFilterWhere(fakeReq(), {
    dateFrom: '2025-01-01',
    dateTo: '2025-12-31',
  });
  const dateClause = where.date as { [Op.gte]?: string; [Op.lte]?: string };
  assert.equal(dateClause[Op.gte], '2025-01-01');
  assert.equal(dateClause[Op.lte], '2025-12-31');
});

test('buildTransactionFilterWhere: dateFrom only populates Op.gte without Op.lte', () => {
  const where = buildTransactionFilterWhere(fakeReq(), { dateFrom: '2025-06-01' });
  const dateClause = where.date as { [Op.gte]?: string; [Op.lte]?: string };
  assert.equal(dateClause[Op.gte], '2025-06-01');
  assert.equal(dateClause[Op.lte], undefined);
});

test('buildTransactionFilterWhere: currency is uppercased and truncated to 3 chars', () => {
  const where = buildTransactionFilterWhere(fakeReq(), { currency: 'usd' });
  assert.equal(where.currency, 'USD');
  const w2 = buildTransactionFilterWhere(fakeReq(), { currency: 'EURO' });
  assert.equal(w2.currency, 'EUR');
});

test('buildTransactionFilterWhere: category and importBatch pass through as strings', () => {
  const where = buildTransactionFilterWhere(fakeReq(), {
    category: 'Groceries',
    importBatch: 'batch-2025-06',
  });
  assert.equal(where.finalCategory, 'Groceries');
  assert.equal(where.importBatch, 'batch-2025-06');
});
