/**
 * Trigger 2: retagging lending reallocates the interest weighted by it.
 *
 * The import trigger covers new billed interest. It does NOT cover the other
 * half of the calculation: which balances the interest is apportioned across.
 * `loadLedgerRows` reads `counterpartyContactId` + `counterpartyRole` off the
 * transactions and `loanDefault` off the contact, so a retag with no import in
 * sight changes every allocated figure — and in practice loans get retagged far
 * more often than statements land.
 *
 * What these tests hold:
 *   - PATCH /api/transactions/:id { counterpartyRole } queues a reallocation;
 *     an unrelated field (notes) does not.
 *   - PATCH /api/contacts/:id { loanDefault } queues one.
 *   - A rejected patch queues nothing — a 400 changed no balance.
 *   - A reallocation that throws still returns 200. A retag is a user action;
 *     a broken allocator must never make one look like it failed.
 *   - POST /api/contacts/interest-allocation still forces a synchronous run.
 *     It stops being the only way the figures move; it stays the way to demand
 *     them now.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {
  isInterestAllocationPending,
  waitForInterestAllocationDrain,
  _resetInterestAllocationCoordinatorForTest,
  _setInterestAllocationCoordinatorForTest,
} from '../contacts/interestAllocationCoordinator';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };
let contactId: number;
let txnId: number;
let userId: number;

function parkQueue(): void {
  _resetInterestAllocationCoordinatorForTest();
  _setInterestAllocationCoordinatorForTest({
    // Unit tests run under NODE_ENV=test, where interestAllocationEnabled is
    // false and marking is a no-op. These tests are about what the triggers do
    // when the feature IS on, so they opt in; the disabled case has its own
    // test at the bottom of this file.
    enabled: true,
    debounceMs: 60_000,
    runner: async () => ({
      windows: 0,
      allocations: 0,
      totalCharged: '0.0000',
      windowSummaries: [],
      dryRun: false,
      elapsedMs: 0,
    }),
  });
}

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  household = await models.Household.create({ name: 'Interest Trigger HH' } as never);
  const user = await models.User.create({
    email: 'interest-trigger@test.local',
    displayName: 'Interest Trigger User',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  userId = user.id;
  const contact = await models.Contact.create({
    householdId: household.id,
    name: 'Caelan Iten-McGrath',
  } as never);
  contactId = contact.id;
  const account = await models.Account.create({
    householdId: household.id,
    name: 'RBC Day to Day Banking',
  } as never);
  const txn = await models.Transaction.create({
    householdId: household.id,
    accountId: account.id,
    importBatch: 'interest-trigger-test',
    date: '2026-01-01',
    merchantRaw: 'ONLINE BANKING TRANSFER',
    merchantClean: 'Transfer',
    amount: '-24275.0000',
    currency: 'CAD',
    sourceRowFingerprint: 'interest-trigger-row-1',
    sourceIdentityFingerprint: 'interest-trigger-id-1',
    counterpartyContactId: contactId,
    visibility: 'shared',
  } as never);
  txnId = txn.id;

  const transactionsRouter = (await import('./transactions')).default;
  const contactsRouter = (await import('./contacts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: userId, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/contacts', contactsRouter);
});

after(async () => {
  _resetInterestAllocationCoordinatorForTest();
  await models.sequelize.close();
});

beforeEach(() => {
  parkQueue();
});

const patchTransaction = (body: Record<string, unknown>) =>
  request(app).patch(`/api/transactions/${txnId}`).send(body);

const patchContact = (body: Record<string, unknown>) =>
  request(app).patch(`/api/contacts/${contactId}`).send(body);

test('patching counterpartyRole queues a reallocation', async () => {
  const res = await patchTransaction({ counterpartyRole: 'loan' });
  assert.equal(res.status, 200);
  assert.equal(isInterestAllocationPending(household.id), true);
});

test('clearing counterpartyRole queues one too', async () => {
  await patchTransaction({ counterpartyRole: 'loan' });
  parkQueue();
  const res = await patchTransaction({ counterpartyRole: null });
  assert.equal(res.status, 200);
  assert.equal(
    isInterestAllocationPending(household.id),
    true,
    'untagging a loan moves the weights exactly as much as tagging one',
  );
});

test('patching counterpartyContactId queues a reallocation', async () => {
  // The ledger rows the allocation weighs are selected by contact id. Moving a
  // transaction to a different person is as much a retag as changing its role.
  const res = await patchTransaction({ counterpartyContactId: contactId });
  assert.equal(res.status, 200);
  assert.equal(isInterestAllocationPending(household.id), true);
});

test('patching an unrelated field queues nothing', async () => {
  const res = await patchTransaction({ notes: 'just a note' });
  assert.equal(res.status, 200);
  assert.equal(
    isInterestAllocationPending(household.id),
    false,
    'a note changes no balance — recomputing the household for it is pure waste',
  );
});

test('a rejected counterpartyRole patch queues nothing', async () => {
  const res = await patchTransaction({ counterpartyRole: 'owner_draw' });
  assert.equal(res.status, 400);
  assert.equal(
    isInterestAllocationPending(household.id),
    false,
    'nothing was written, so nothing needs reallocating',
  );
});

test('patching loanDefault queues a reallocation', async () => {
  const res = await patchContact({ loanDefault: true });
  assert.equal(res.status, 200);
  assert.equal(isInterestAllocationPending(household.id), true);
});

test('patching an unrelated contact field queues nothing', async () => {
  const res = await patchContact({ notes: 'lives in Halifax' });
  assert.equal(res.status, 200);
  assert.equal(isInterestAllocationPending(household.id), false);
});

test('a rejected loanDefault patch queues nothing', async () => {
  const res = await patchContact({ loanDefault: 'maybe' });
  assert.equal(res.status, 400);
  assert.equal(isInterestAllocationPending(household.id), false);
});

test('a failing reallocation does not fail the PATCH', async () => {
  let attempted = 0;
  _resetInterestAllocationCoordinatorForTest();
  _setInterestAllocationCoordinatorForTest({
    enabled: true,
    debounceMs: 0,
    runner: async () => {
      attempted += 1;
      throw new Error('allocator exploded');
    },
  });

  const res = await patchTransaction({ counterpartyRole: 'loan' });
  await waitForInterestAllocationDrain();

  assert.equal(res.status, 200, 'a retag is the user\'s action; the allocator is not');
  const fresh = await models.Transaction.findByPk(txnId);
  assert.equal(fresh?.counterpartyRole, 'loan', 'the retag must be persisted regardless');
  assert.equal(attempted, 1);
});

test('a burst of retags collapses into one recomputation', async () => {
  let runs = 0;
  _resetInterestAllocationCoordinatorForTest();
  _setInterestAllocationCoordinatorForTest({
    enabled: true,
    // Comfortably longer than six sequential supertest round-trips: the point
    // is that everything landing inside one window costs one run, not that the
    // window is any particular length.
    debounceMs: 2_000,
    runner: async () => {
      runs += 1;
      return {
        windows: 0, allocations: 0, totalCharged: '0.0000',
        windowSummaries: [], dryRun: false, elapsedMs: 0,
      };
    },
  });

  for (const role of ['loan', 'repayment', 'loan', 'repayment', 'loan', null]) {
    await patchTransaction({ counterpartyRole: role });
  }
  await waitForInterestAllocationDrain();

  assert.equal(
    runs,
    1,
    `six retags in a burst must cost one recomputation, not six — got ${runs}`,
  );
});

test('the manual endpoint still forces a synchronous run', async () => {
  const res = await request(app)
    .post('/api/contacts/interest-allocation')
    .send({ dryRun: true });
  assert.equal(res.status, 200, 'the force-refresh button is kept, not replaced');
  assert.equal(res.body.dryRun, true);
  assert.equal(typeof res.body.totalCharged, 'string');
});

test('with the feature disabled a retag queues nothing — through the real route', async () => {
  // The unit-level version of this lives in interestAllocationCoordinator.test.ts.
  // This one goes through the actual PATCH handler, because the handler is what
  // fires in CI: a worker running this file with INTEREST_ALLOCATION_ENABLED off
  // (which NODE_ENV=test makes the default) must not arm anything.
  _resetInterestAllocationCoordinatorForTest();
  _setInterestAllocationCoordinatorForTest({
    enabled: false,
    debounceMs: 0,
    runner: async () => {
      throw new Error('the allocator must never be reached while disabled');
    },
  });

  const res = await patchTransaction({ counterpartyRole: 'loan' });
  await waitForInterestAllocationDrain();

  assert.equal(res.status, 200, 'the retag itself is unaffected by the feature flag');
  const fresh = await models.Transaction.findByPk(txnId);
  assert.equal(fresh?.counterpartyRole, 'loan');
  assert.equal(
    isInterestAllocationPending(household.id),
    false,
    'nothing queued means nothing armed — the four-hour shard-3 hang cannot recur',
  );
});

test('the manual endpoint still runs even with the feature disabled', async () => {
  // Disabled switches the AUTOMATIC trigger off. It must not disable the
  // button: the endpoint calls runInterestAllocation directly and never goes
  // near the coordinator's queue.
  _resetInterestAllocationCoordinatorForTest();
  _setInterestAllocationCoordinatorForTest({
    enabled: false,
    debounceMs: 0,
    runner: async () => {
      throw new Error('the manual endpoint must not route through the queue');
    },
  });

  const res = await request(app)
    .post('/api/contacts/interest-allocation')
    .send({ dryRun: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(typeof res.body.totalCharged, 'string');
  assert.equal(isInterestAllocationPending(household.id), false);
});
