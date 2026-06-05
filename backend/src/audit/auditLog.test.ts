/**
 * Unit tests for the audit-log helper (Cashflow #228).
 *
 * Exercises:
 *   - recordAudit({ req }) reads actor + household from the request.
 *   - recordAudit({ householdId, actorUserId }) accepts system-emitted rows.
 *   - JSON oversize payloads are truncated rather than failing the insert.
 *   - diffPatchableFields treats numeric-string ↔ number as equal.
 *   - Audit failures are SWALLOWED by default (so callers can't fail a
 *     mutation just because the audit insert blew up).
 *   - rethrowOnError: true surfaces the failure to the caller.
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let AuditLog: typeof import('../models').AuditLog;
let Household: typeof import('../models').Household;
let User: typeof import('../models').User;
let recordAudit: typeof import('./log').recordAudit;
let diffPatchableFields: typeof import('./log').diffPatchableFields;

interface FakeReq {
  auth?: {
    user: { id: number; globalRole?: string };
    household: { id: number };
    role: string;
  };
}

function fakeReq(userId: number, householdId: number): FakeReq {
  return {
    auth: {
      user: { id: userId, globalRole: 'user' },
      household: { id: householdId },
      role: 'owner',
    },
  };
}

before(async () => {
  const models = await import('../models');
  sequelize = models.sequelize;
  AuditLog = models.AuditLog;
  Household = models.Household;
  User = models.User;
  const audit = await import('./log');
  recordAudit = audit.recordAudit;
  diffPatchableFields = audit.diffPatchableFields;
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await AuditLog.destroy({ where: {}, truncate: true });
  await User.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
});

test('recordAudit with req writes a row scoped to the request actor + household', async () => {
  const hh = await Household.create({ name: 'H' });
  const user = await User.create({
    email: `audit-${Date.now()}@example.com`,
    displayName: 'Audit Tester',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'y',
    passwordParams: 'p',
  });

  await recordAudit({
    req: fakeReq(user.id, hh.id) as unknown as import('express').Request,
    action: 'transaction.updated',
    entityType: 'transaction',
    entityId: 42,
    summary: 'set category to Food',
    before: { categoryOverride: null },
    after: { categoryOverride: 'Food' },
    metadata: { requestId: 'r1' },
  });

  const rows = await AuditLog.findAll({ order: [['id', 'ASC']] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].householdId, hh.id);
  assert.equal(rows[0].actorUserId, user.id);
  assert.equal(rows[0].action, 'transaction.updated');
  assert.equal(rows[0].entityType, 'transaction');
  assert.equal(rows[0].entityId, 42);
  assert.equal(rows[0].summary, 'set category to Food');
  assert.deepEqual(rows[0].after, { categoryOverride: 'Food' });
  assert.deepEqual(rows[0].metadata, { requestId: 'r1' });
});

test('recordAudit accepts householdId + actorUserId without a request (system-emitted)', async () => {
  const hh = await Household.create({ name: 'H' });
  await recordAudit({
    householdId: hh.id,
    actorUserId: null,
    action: 'import.committed',
    entityType: 'import',
    summary: 'system import',
  });
  const rows = await AuditLog.findAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorUserId, null);
});

test('recordAudit truncates oversized JSON payloads instead of failing', async () => {
  const hh = await Household.create({ name: 'H' });
  // ~50 KB payload — well over the 16 KB cap per field.
  const big = { items: Array.from({ length: 5000 }).map((_, i) => `entry-${i}`) };
  await recordAudit({
    householdId: hh.id,
    action: 'transaction.bulk_updated',
    entityType: 'transaction',
    after: big,
  });
  const row = await AuditLog.findOne();
  assert.ok(row);
  // The trimmed payload includes the sentinel marker.
  const after = row!.after as Record<string, unknown> | null;
  assert.ok(after && typeof after === 'object');
  assert.equal((after as Record<string, unknown>).__auditTruncated, 'value_too_large');
});

test('recordAudit truncates summary longer than 255 chars', async () => {
  const hh = await Household.create({ name: 'H' });
  const longSummary = 'x'.repeat(400);
  await recordAudit({
    householdId: hh.id,
    action: 'transaction.updated',
    entityType: 'transaction',
    summary: longSummary,
  });
  const row = await AuditLog.findOne();
  assert.ok(row);
  assert.ok(row!.summary && row!.summary.length <= 255);
});

test('recordAudit without householdId or req is a no-op (logged, not thrown)', async () => {
  // Should NOT throw — the helper logs and returns. Workflow must not fail
  // because of an audit miss-configuration.
  await recordAudit({
    action: 'transaction.updated',
    entityType: 'transaction',
  });
  const count = await AuditLog.count();
  assert.equal(count, 0);
});

test('recordAudit with rethrowOnError surfaces a missing householdId', async () => {
  await assert.rejects(
    () =>
      recordAudit({
        action: 'transaction.updated',
        entityType: 'transaction',
        rethrowOnError: true,
      }),
    /householdId/,
  );
});

test('diffPatchableFields returns empty diff when nothing changed', () => {
  const prev = { a: 'x', b: 1, c: null };
  const next = { a: 'x', b: 1, c: null };
  const diff = diffPatchableFields(prev, next, ['a', 'b', 'c']);
  assert.deepEqual(diff.before, {});
  assert.deepEqual(diff.after, {});
});

test('diffPatchableFields treats numeric-string and number as equal', () => {
  // Sequelize DECIMAL columns return strings; we don't want every patch
  // to claim "amount changed" just because the request body sent a number.
  const prev = { amount: '12.5000' };
  const next = { amount: 12.5 };
  const diff = diffPatchableFields(prev, next, ['amount']);
  assert.deepEqual(diff.after, {});
});

test('diffPatchableFields surfaces null↔value transitions', () => {
  const prev = { category: null, splitType: 'me' };
  const next = { category: 'Food', splitType: 'partner' };
  const diff = diffPatchableFields(prev, next, ['category', 'splitType']);
  assert.deepEqual(diff.before, { category: null, splitType: 'me' });
  assert.deepEqual(diff.after, { category: 'Food', splitType: 'partner' });
});
