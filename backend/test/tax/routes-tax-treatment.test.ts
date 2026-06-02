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

  const { sequelize } = await import('../../src/db.js');
  // Import models BEFORE sync so all model tables are registered and created.
  const models = await import('../../src/models/index.js');
  await sequelize.sync({ force: true });

  const mod = await import('../../src/app.js');
  app = mod.default;

  const { hashPassword, hashToken } = await import('../../src/auth/password.js');

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
  const { sequelize } = await import('../../src/db.js');
  await sequelize.close();
});

test('PATCH /api/transfers/:id/tax-treatment sets taxTreatment on both legs of a linked pair', async () => {
  const models = await import('../../src/models/index.js');

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
    .send({ taxTreatment: 'non_eligible_dividend' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  // Reload both from DB and verify taxTreatment was set on each
  await a.reload();
  await b.reload();
  assert.equal(
    (a as any).taxTreatment,
    'non_eligible_dividend',
    `expected a.taxTreatment 'non_eligible_dividend', got '${(a as any).taxTreatment}'`,
  );
  assert.equal(
    (b as any).taxTreatment,
    'non_eligible_dividend',
    `expected b.taxTreatment 'non_eligible_dividend', got '${(b as any).taxTreatment}'`,
  );
});

test('PATCH /api/transfers/:id/tax-treatment rejects an invalid treatment', async () => {
  const models = await import('../../src/models/index.js');

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
    .send({ taxTreatment: 'bogus' });

  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('PATCH /api/transfers/:id/tax-treatment sets taxTreatment on an unlinked row', async () => {
  const models = await import('../../src/models/index.js');

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
    .send({ taxTreatment: 'salary' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  await txn.reload();
  assert.equal(
    (txn as any).taxTreatment,
    'salary',
    `expected txn.taxTreatment 'salary', got '${(txn as any).taxTreatment}'`,
  );
});
