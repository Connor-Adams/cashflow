/**
 * Unit tests for the finance-events helper (Cashflow #238).
 *
 * Exercises:
 *   - recordFinanceEvent({ req }) reads actor + household from the request.
 *   - recordFinanceEvent({ householdId, actorUserId }) accepts
 *     system-emitted events.
 *   - Oversized JSON payloads are truncated, not failed.
 *   - Best-effort by default: missing householdId is a no-op, not a throw.
 *   - rethrowOnError surfaces the failure (used by tests).
 *   - readEntityEvents returns the stream in replay order (createdAt ASC).
 *   - Distinct from audit_log — the two streams are independent
 *     (one can succeed and the other fail without affecting it).
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let FinanceEvent: typeof import('../src/models').FinanceEvent;
let Household: typeof import('../src/models').Household;
let User: typeof import('../src/models').User;
let recordFinanceEvent: typeof import('../src/events/financeEvents').recordFinanceEvent;
let readEntityEvents: typeof import('../src/events/financeEvents').readEntityEvents;
let FINANCE_EVENT_TYPES: typeof import('../src/events/financeEvents').FINANCE_EVENT_TYPES;
let FINANCE_EVENT_ENTITY_TYPES: typeof import('../src/events/financeEvents').FINANCE_EVENT_ENTITY_TYPES;

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
  const models = await import('../src/models');
  sequelize = models.sequelize;
  FinanceEvent = models.FinanceEvent;
  Household = models.Household;
  User = models.User;
  const events = await import('../src/events/financeEvents');
  recordFinanceEvent = events.recordFinanceEvent;
  readEntityEvents = events.readEntityEvents;
  FINANCE_EVENT_TYPES = events.FINANCE_EVENT_TYPES;
  FINANCE_EVENT_ENTITY_TYPES = events.FINANCE_EVENT_ENTITY_TYPES;
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await FinanceEvent.destroy({ where: {}, truncate: true });
  await User.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
});

test('recordFinanceEvent with req writes a row scoped to the request actor + household', async () => {
  const hh = await Household.create({ name: 'H' });
  const user = await User.create({
    email: `finevt-${Date.now()}@example.com`,
    displayName: 'Finance Event Tester',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'y',
    passwordParams: 'p',
  });

  await recordFinanceEvent({
    req: fakeReq(user.id, hh.id) as unknown as import('express').Request,
    type: FINANCE_EVENT_TYPES.TransactionUpdated,
    entityType: FINANCE_EVENT_ENTITY_TYPES.Transaction,
    entityId: 42,
    payload: { changed: ['categoryOverride'], after: { categoryOverride: 'Food' } },
  });

  const rows = await FinanceEvent.findAll({ order: [['id', 'ASC']] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].householdId, hh.id);
  assert.equal(rows[0].actorUserId, user.id);
  assert.equal(rows[0].type, 'transaction.updated');
  assert.equal(rows[0].entityType, 'transaction');
  assert.equal(rows[0].entityId, 42);
  const payload = rows[0].payload as { changed: string[]; after: Record<string, unknown> };
  assert.deepEqual(payload.changed, ['categoryOverride']);
  assert.deepEqual(payload.after, { categoryOverride: 'Food' });
});

test('recordFinanceEvent accepts householdId + actorUserId without a request (system-emitted)', async () => {
  const hh = await Household.create({ name: 'H' });
  await recordFinanceEvent({
    householdId: hh.id,
    actorUserId: null,
    type: FINANCE_EVENT_TYPES.ImportCommitted,
    entityType: FINANCE_EVENT_ENTITY_TYPES.Import,
    entityId: null,
    payload: { source: 'system-cron', inserted: 5 },
  });
  const rows = await FinanceEvent.findAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorUserId, null);
  assert.equal(rows[0].type, 'import.committed');
  assert.equal(rows[0].entityId, null);
});

test('recordFinanceEvent truncates oversized JSON payloads instead of failing', async () => {
  const hh = await Household.create({ name: 'H' });
  // ~50 KB payload — well over the 16 KB cap.
  const big = {
    items: Array.from({ length: 5000 }).map((_, i) => `entry-${i}`),
  };
  await recordFinanceEvent({
    householdId: hh.id,
    type: FINANCE_EVENT_TYPES.TransactionBulkUpdated,
    entityType: FINANCE_EVENT_ENTITY_TYPES.Transaction,
    payload: big,
  });
  const row = await FinanceEvent.findOne();
  assert.ok(row);
  const payload = row!.payload as Record<string, unknown> | null;
  assert.ok(payload && typeof payload === 'object');
  assert.equal(
    (payload as Record<string, unknown>).__financeEventTruncated,
    'value_too_large',
  );
});

test('recordFinanceEvent without householdId or req is a no-op (logged, not thrown)', async () => {
  // Must NOT throw — the helper logs and returns. Workflow must not fail
  // because of a finance-event misconfiguration.
  await recordFinanceEvent({
    type: FINANCE_EVENT_TYPES.TransactionUpdated,
    entityType: FINANCE_EVENT_ENTITY_TYPES.Transaction,
  });
  const count = await FinanceEvent.count();
  assert.equal(count, 0);
});

test('recordFinanceEvent with rethrowOnError surfaces a missing householdId', async () => {
  await assert.rejects(
    () =>
      recordFinanceEvent({
        type: FINANCE_EVENT_TYPES.TransactionUpdated,
        entityType: FINANCE_EVENT_ENTITY_TYPES.Transaction,
        rethrowOnError: true,
      }),
    /householdId/,
  );
});

test('recordFinanceEvent persists explicit occurredAt', async () => {
  const hh = await Household.create({ name: 'H' });
  const when = new Date('2026-01-15T10:00:00Z');
  await recordFinanceEvent({
    householdId: hh.id,
    type: FINANCE_EVENT_TYPES.SettlementCreated,
    entityType: FINANCE_EVENT_ENTITY_TYPES.Settlement,
    entityId: 7,
    payload: { amount: '50.00' },
    occurredAt: when,
  });
  const row = await FinanceEvent.findOne();
  assert.ok(row);
  assert.equal(row!.occurredAt.toISOString(), when.toISOString());
});

test('readEntityEvents returns stream in replay order (createdAt ASC)', async () => {
  const hh = await Household.create({ name: 'H' });
  const user = await User.create({
    email: `finevt-replay-${Date.now()}@example.com`,
    displayName: 'Replay',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'y',
    passwordParams: 'p',
  });

  // Emit three events on the same entity, asserting we keep insert order.
  await recordFinanceEvent({
    req: fakeReq(user.id, hh.id) as unknown as import('express').Request,
    type: FINANCE_EVENT_TYPES.RuleCreated,
    entityType: FINANCE_EVENT_ENTITY_TYPES.Rule,
    entityId: 99,
    payload: { step: 1 },
  });
  await recordFinanceEvent({
    req: fakeReq(user.id, hh.id) as unknown as import('express').Request,
    type: FINANCE_EVENT_TYPES.RuleUpdated,
    entityType: FINANCE_EVENT_ENTITY_TYPES.Rule,
    entityId: 99,
    payload: { step: 2 },
  });
  await recordFinanceEvent({
    req: fakeReq(user.id, hh.id) as unknown as import('express').Request,
    type: FINANCE_EVENT_TYPES.RuleDeleted,
    entityType: FINANCE_EVENT_ENTITY_TYPES.Rule,
    entityId: 99,
    payload: { step: 3 },
  });

  const stream = await readEntityEvents({
    householdId: hh.id,
    entityType: 'rule',
    entityId: 99,
  });
  assert.equal(stream.length, 3);
  assert.deepEqual(
    stream.map((e) => (e.payload as { step: number }).step),
    [1, 2, 3],
  );
  assert.equal(stream[0].type, 'rule.created');
  assert.equal(stream[1].type, 'rule.updated');
  assert.equal(stream[2].type, 'rule.deleted');
});

test('readEntityEvents respects household scope', async () => {
  const hhA = await Household.create({ name: 'A' });
  const hhB = await Household.create({ name: 'B' });

  await recordFinanceEvent({
    householdId: hhA.id,
    type: 'transaction.updated',
    entityType: 'transaction',
    entityId: 1,
    payload: { who: 'A' },
  });
  await recordFinanceEvent({
    householdId: hhB.id,
    type: 'transaction.updated',
    entityType: 'transaction',
    entityId: 1,
    payload: { who: 'B' },
  });

  const fromA = await readEntityEvents({
    householdId: hhA.id,
    entityType: 'transaction',
    entityId: 1,
  });
  const fromB = await readEntityEvents({
    householdId: hhB.id,
    entityType: 'transaction',
    entityId: 1,
  });
  assert.equal(fromA.length, 1);
  assert.equal(fromB.length, 1);
  assert.equal((fromA[0].payload as { who: string }).who, 'A');
  assert.equal((fromB[0].payload as { who: string }).who, 'B');
});

test('finance_events stream is append-only — no update API exposed', async () => {
  // The helper module exports recordFinanceEvent + readEntityEvents only.
  // It does NOT export an update or delete helper. Code-level invariant.
  const mod = await import('../src/events/financeEvents');
  assert.ok('recordFinanceEvent' in mod);
  assert.ok('readEntityEvents' in mod);
  assert.equal(
    'updateFinanceEvent' in mod,
    false,
    'no update helper should exist',
  );
  assert.equal(
    'deleteFinanceEvent' in mod,
    false,
    'no delete helper should exist',
  );
});
