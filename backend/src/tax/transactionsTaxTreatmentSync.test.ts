/**
 * Regression tests: the transactions write paths must keep a linked transfer
 * pair's `taxTreatmentOverride` in sync across BOTH legs.
 *
 * Background: the per-leg tax fact builders (buildPersonalFacts /
 * buildCorpFacts / shareholderLoanBalance) read `taxTreatmentOverride` from
 * each leg independently and never follow `linkedTransactionId`. So setting a
 * treatment on only ONE leg of a corp↔personal transfer pair desyncs the pair
 * and yields inconsistent T1/T2. The dedicated PATCH
 * /api/transfers/:id/tax-treatment already mirrors both legs; these tests pin
 * the same invariant for the single-leg transactions surfaces that
 * ReviewInboxPage / TransactionsPage actually use:
 *   - PATCH /api/transactions/:id
 *   - POST  /api/transactions/bulk-patch
 *
 * Harness mirrors routes-tax-treatment.test.ts (sequelize.sync force, direct
 * User/Household/Session creation, cookie-injected supertest agent).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let accountId: number;

before(async () => {
  process.env.NODE_ENV = 'test';

  const { sequelize } = await import('../db.js');
  // Import models BEFORE sync so all model tables are registered and created.
  const models = await import('../models/index.js');
  await sequelize.sync({ force: true });

  const mod = await import('../app.js');
  app = mod.default;

  const { hashPassword, hashToken } = await import('../auth/password.js');

  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `txn-tax-sync-${Date.now()}@example.com`,
    displayName: 'Txn Tax Sync Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Txn Tax Sync HH' });
  householdId = household.id;
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });

  const account = await models.Account.create({
    name: 'Chk',
    householdId: household.id,
    accountType: 'checking',
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);
  accountId = account.id;

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => {
  const { sequelize } = await import('../db.js');
  await sequelize.close();
});

/**
 * Create a linked corp↔personal transfer pair and return the two leg ids.
 * `a` is the inbound (positive) leg, `b` the outbound (negative) leg.
 */
async function createLinkedPair(label: string): Promise<{ aId: number; bId: number }> {
  const models = await import('../models/index.js');
  const ts = `${label}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const a = await models.Transaction.create({
    accountId,
    householdId,
    date: '2025-01-15',
    amount: '5000',
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    merchantRaw: `TRANSFER IN ${label}`,
    merchantClean: `TRANSFER IN ${label}`,
    importBatch: 'b',
    sourceRowFingerprint: `fp-a-${ts}`,
    sourceIdentityFingerprint: `sif-a-${ts}`,
  } as never);
  const b = await models.Transaction.create({
    accountId,
    householdId,
    date: '2025-01-15',
    amount: '-5000',
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    linkedTransactionId: a.id,
    merchantRaw: `TRANSFER OUT ${label}`,
    merchantClean: `TRANSFER OUT ${label}`,
    importBatch: 'b',
    sourceRowFingerprint: `fp-b-${ts}`,
    sourceIdentityFingerprint: `sif-b-${ts}`,
  } as never);
  await a.update({ linkedTransactionId: b.id });
  return { aId: a.id, bId: b.id };
}

async function treatmentOf(id: number): Promise<unknown> {
  const models = await import('../models/index.js');
  const row = await models.Transaction.findByPk(id);
  return (row as any)?.taxTreatmentOverride ?? null;
}

test('PATCH /api/transactions/:id setting taxTreatmentOverride on one transfer leg syncs BOTH legs', async () => {
  const { aId, bId } = await createLinkedPair('single');

  const res = await authed
    .patch(`/api/transactions/${aId}`)
    .send({ taxTreatmentOverride: 'non_eligible_dividend' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(
    await treatmentOf(aId),
    'non_eligible_dividend',
    'edited leg a should have the treatment',
  );
  assert.equal(
    await treatmentOf(bId),
    'non_eligible_dividend',
    'linked sibling leg b should be synced to the same treatment',
  );
});

test('PATCH /api/transactions/:id clearing taxTreatmentOverride (null) clears BOTH legs', async () => {
  const { aId, bId } = await createLinkedPair('clear');

  const setRes = await authed
    .patch(`/api/transactions/${aId}`)
    .send({ taxTreatmentOverride: 'salary' });
  assert.equal(setRes.status, 200, `set: ${setRes.status}: ${JSON.stringify(setRes.body)}`);
  assert.equal(await treatmentOf(bId), 'salary', 'sibling set before clear');

  const clearRes = await authed
    .patch(`/api/transactions/${aId}`)
    .send({ taxTreatmentOverride: null });
  assert.equal(clearRes.status, 200, `clear: ${clearRes.status}: ${JSON.stringify(clearRes.body)}`);

  assert.equal(await treatmentOf(aId), null, 'edited leg a should be cleared');
  assert.equal(await treatmentOf(bId), null, 'linked sibling leg b should also be cleared');
});

test('POST /api/transactions/bulk-patch with taxTreatmentOverride on a transfer leg syncs BOTH legs', async () => {
  const { aId, bId } = await createLinkedPair('bulk');

  const res = await authed
    .post('/api/transactions/bulk-patch')
    .send({ ids: [aId], patch: { taxTreatmentOverride: 'non_eligible_dividend' } });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(await treatmentOf(aId), 'non_eligible_dividend', 'selected leg a set');
  assert.equal(
    await treatmentOf(bId),
    'non_eligible_dividend',
    'linked sibling leg b should be synced even though only leg a was in the bulk id set',
  );
});

test('PATCH /api/transactions/:id on an UNLINKED row only touches that row', async () => {
  const models = await import('../models/index.js');
  const ts = `unlinked-${Date.now()}`;
  const solo = await models.Transaction.create({
    accountId,
    householdId,
    date: '2025-03-01',
    amount: '3000',
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    merchantRaw: 'PAYROLL',
    merchantClean: 'PAYROLL',
    importBatch: 'b',
    sourceRowFingerprint: `fp-${ts}`,
    sourceIdentityFingerprint: `sif-${ts}`,
  } as never);

  const res = await authed
    .patch(`/api/transactions/${solo.id}`)
    .send({ taxTreatmentOverride: 'salary' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(await treatmentOf(solo.id), 'salary', 'unlinked row gets the treatment');
});
