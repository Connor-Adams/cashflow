/**
 * Integration tests for PATCH /api/transfers/:id/tax-treatment (Task 5).
 *
 * Mirrors the auth-setup pattern from routes-reconciliation.test.ts:
 * - sequelize.sync({ force: true }) instead of running migrations.
 * - Models imported BEFORE sync so all model tables are registered/created.
 * - Direct User + Household + HouseholdMember + Session creation, then
 *   request.agent(app) with cookie injection.
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
    email: `tax-treatment-${Date.now()}@example.com`,
    displayName: 'Tax Treatment Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Tax Treatment HH' });
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

test('PATCH /api/transfers/:id/tax-treatment sets taxTreatmentOverride on both legs of a linked pair', async () => {
  const models = await import('../models/index.js');

  // Create transaction a (inbound, positive amount)
  const a = await models.Transaction.create({
    accountId,
    householdId,
    date: '2025-01-15',
    amount: '5000',
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    merchantRaw: 'TRANSFER IN',
    merchantClean: 'TRANSFER IN',
    importBatch: 'b',
    sourceRowFingerprint: `fp-a-${Date.now()}`,
    sourceIdentityFingerprint: `sif-a-${Date.now()}`,
  } as never);

  // Create transaction b (outbound, negative amount)
  const b = await models.Transaction.create({
    accountId,
    householdId,
    date: '2025-01-15',
    amount: '-5000',
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    linkedTransactionId: a.id,
    merchantRaw: 'TRANSFER OUT',
    merchantClean: 'TRANSFER OUT',
    importBatch: 'b',
    sourceRowFingerprint: `fp-b-${Date.now()}`,
    sourceIdentityFingerprint: `sif-b-${Date.now()}`,
  } as never);

  // Link a → b
  await a.update({ linkedTransactionId: b.id });

  const res = await authed
    .patch(`/api/transfers/${a.id}/tax-treatment`)
    .send({ taxTreatmentOverride: 'non_eligible_dividend' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  // Reload both from DB and verify taxTreatmentOverride was set on each
  await a.reload();
  await b.reload();
  assert.equal(
    (a as any).taxTreatmentOverride,
    'non_eligible_dividend',
    `expected a.taxTreatmentOverride 'non_eligible_dividend', got '${(a as any).taxTreatmentOverride}'`,
  );
  assert.equal(
    (b as any).taxTreatmentOverride,
    'non_eligible_dividend',
    `expected b.taxTreatmentOverride 'non_eligible_dividend', got '${(b as any).taxTreatmentOverride}'`,
  );
});

test('PATCH /api/transfers/:id/tax-treatment rejects an invalid treatment', async () => {
  const models = await import('../models/index.js');

  const txn = await models.Transaction.create({
    accountId,
    householdId,
    date: '2025-02-01',
    amount: '1000',
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    merchantRaw: 'TEST',
    merchantClean: 'TEST',
    importBatch: 'b',
    sourceRowFingerprint: `fp-c-${Date.now()}`,
    sourceIdentityFingerprint: `sif-c-${Date.now()}`,
  } as never);

  const res = await authed
    .patch(`/api/transfers/${txn.id}/tax-treatment`)
    .send({ taxTreatmentOverride: 'bogus' });

  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('PATCH /api/transfers/:id/tax-treatment sets taxTreatmentOverride on an unlinked row', async () => {
  const models = await import('../models/index.js');

  const txn = await models.Transaction.create({
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
    sourceRowFingerprint: `fp-d-${Date.now()}`,
    sourceIdentityFingerprint: `sif-d-${Date.now()}`,
  } as never);

  const res = await authed
    .patch(`/api/transfers/${txn.id}/tax-treatment`)
    .send({ taxTreatmentOverride: 'salary' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  await txn.reload();
  assert.equal(
    (txn as any).taxTreatmentOverride,
    'salary',
    `expected txn.taxTreatmentOverride 'salary', got '${(txn as any).taxTreatmentOverride}'`,
  );
});

test('PATCH /api/transfers/:id/tax-treatment set then clear leaves both legs null', async () => {
  const models = await import('../models/index.js');
  const ts = Date.now();

  const a = await models.Transaction.create({
    accountId,
    householdId,
    date: '2025-04-01',
    amount: '6000',
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    merchantRaw: 'CLEAR TEST IN',
    merchantClean: 'CLEAR TEST IN',
    importBatch: 'b',
    sourceRowFingerprint: `fp-e1-${ts}`,
    sourceIdentityFingerprint: `sif-e1-${ts}`,
  } as never);

  const b = await models.Transaction.create({
    accountId,
    householdId,
    date: '2025-04-01',
    amount: '-6000',
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    linkedTransactionId: a.id,
    merchantRaw: 'CLEAR TEST OUT',
    merchantClean: 'CLEAR TEST OUT',
    importBatch: 'b',
    sourceRowFingerprint: `fp-e2-${ts}`,
    sourceIdentityFingerprint: `sif-e2-${ts}`,
  } as never);

  await a.update({ linkedTransactionId: b.id });

  // Set treatment
  const setRes = await authed
    .patch(`/api/transfers/${a.id}/tax-treatment`)
    .send({ taxTreatmentOverride: 'salary' });
  assert.equal(setRes.status, 200, `set: expected 200, got ${setRes.status}: ${JSON.stringify(setRes.body)}`);

  // Clear treatment
  const clearRes = await authed
    .patch(`/api/transfers/${a.id}/tax-treatment`)
    .send({ taxTreatmentOverride: null });
  assert.equal(clearRes.status, 200, `clear: expected 200, got ${clearRes.status}: ${JSON.stringify(clearRes.body)}`);

  await a.reload();
  await b.reload();
  assert.equal(
    (a as any).taxTreatmentOverride,
    null,
    `expected a.taxTreatmentOverride null, got '${(a as any).taxTreatmentOverride}'`,
  );
  assert.equal(
    (b as any).taxTreatmentOverride,
    null,
    `expected b.taxTreatmentOverride null, got '${(b as any).taxTreatmentOverride}'`,
  );
});
