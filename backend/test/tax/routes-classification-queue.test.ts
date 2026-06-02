/**
 * Integration tests for GET /api/tax/classification-queue (Task 6).
 *
 * Mirrors the auth-setup pattern from routes-tax-treatment.test.ts:
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
let personalEntityId: number;
let corpEntityId: number;
let personalAccountId: number;
let corpAccountId: number;

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
    email: `classification-queue-${Date.now()}@example.com`,
    displayName: 'Classification Queue Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });

  const household = await models.Household.create({ name: 'Classification Queue HH' });
  householdId = household.id;

  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });

  // Create personal entity
  const personalEntity = await models.Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Test Person',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);
  personalEntityId = personalEntity.id;

  // Create corp entity in the same household
  const corpEntity = await models.Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'Test Corp Inc',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  } as never);
  corpEntityId = corpEntity.id;

  // Create accounts for each entity
  const personalAccount = await models.Account.create({
    name: 'Personal Chk',
    householdId: household.id,
    accountType: 'checking',
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);
  personalAccountId = personalAccount.id;

  const corpAccount = await models.Account.create({
    name: 'Corp Chk',
    householdId: household.id,
    accountType: 'checking',
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);
  corpAccountId = corpAccount.id;

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

test('GET /api/tax/classification-queue returns corpDistributions and payroll', async () => {
  const models = await import('../../src/models/index.js');
  const ts = Date.now();

  // Seed a corp→personal transfer PAIR:
  // personal leg: entityId=personal, amount 5000, txnType=transfer, taxTreatmentOverride=null
  const personalLeg = await models.Transaction.create({
    accountId: personalAccountId,
    householdId,
    entityId: personalEntityId,
    date: '2025-06-15',
    amount: '5000',
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    merchantRaw: 'CORP DISTRIBUTION IN',
    merchantClean: 'CORP DISTRIBUTION IN',
    importBatch: 'b',
    sourceRowFingerprint: `fp-personal-${ts}`,
    sourceIdentityFingerprint: `sif-personal-${ts}`,
  } as never);

  // corp leg: entityId=corp, amount -5000, txnType=transfer, taxTreatmentOverride=null
  const corpLeg = await models.Transaction.create({
    accountId: corpAccountId,
    householdId,
    entityId: corpEntityId,
    date: '2025-06-15',
    amount: '-5000',
    currency: 'CAD',
    txnType: 'transfer',
    visibility: 'shared',
    merchantRaw: 'CORP DISTRIBUTION OUT',
    merchantClean: 'CORP DISTRIBUTION OUT',
    importBatch: 'b',
    sourceRowFingerprint: `fp-corp-${ts}`,
    sourceIdentityFingerprint: `sif-corp-${ts}`,
  } as never);

  // Link both legs to each other
  await personalLeg.update({ linkedTransactionId: corpLeg.id });
  await corpLeg.update({ linkedTransactionId: personalLeg.id });

  // Seed a payroll deposit on the personal account:
  // txnType='income', amount 3000, taxTreatmentOverride=null
  const payrollTxn = await models.Transaction.create({
    accountId: personalAccountId,
    householdId,
    entityId: personalEntityId,
    date: '2025-07-01',
    amount: '3000',
    currency: 'CAD',
    txnType: 'income',
    visibility: 'shared',
    merchantRaw: 'PAYROLL DEPOSIT',
    merchantClean: 'PAYROLL DEPOSIT',
    importBatch: 'b',
    sourceRowFingerprint: `fp-payroll-${ts}`,
    sourceIdentityFingerprint: `sif-payroll-${ts}`,
  } as never);

  const res = await authed.get(
    `/api/tax/classification-queue?entityId=${personalEntityId}&year=2025`,
  );

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  assert.ok(
    Array.isArray(res.body.corpDistributions),
    `expected corpDistributions to be an array, got: ${JSON.stringify(res.body.corpDistributions)}`,
  );
  assert.equal(
    res.body.corpDistributions.length,
    1,
    `expected 1 corpDistribution, got ${res.body.corpDistributions.length}`,
  );
  assert.equal(
    res.body.corpDistributions[0].personal.id,
    personalLeg.id,
    `expected personal leg id ${personalLeg.id}, got ${res.body.corpDistributions[0].personal.id}`,
  );
  assert.equal(
    res.body.corpDistributions[0].corp.id,
    corpLeg.id,
    `expected corp leg id ${corpLeg.id}, got ${res.body.corpDistributions[0].corp.id}`,
  );
  assert.equal(res.body.corpDistributions[0].personal.accountName, 'Personal Chk');
  assert.equal(res.body.corpDistributions[0].corp.accountName, 'Corp Chk');
  assert.equal(res.body.payroll[0].accountName, 'Personal Chk');

  assert.ok(
    Array.isArray(res.body.payroll),
    `expected payroll to be an array, got: ${JSON.stringify(res.body.payroll)}`,
  );
  assert.equal(
    res.body.payroll.length,
    1,
    `expected 1 payroll item, got ${res.body.payroll.length}`,
  );
  assert.equal(
    res.body.payroll[0].id,
    payrollTxn.id,
    `expected payroll txn id ${payrollTxn.id}, got ${res.body.payroll[0].id}`,
  );
});

test('GET /api/tax/classification-queue returns 400 if entityId or year missing', async () => {
  const res = await authed.get('/api/tax/classification-queue?year=2025');
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('GET /api/tax/classification-queue returns 404 for unknown entity', async () => {
  const res = await authed.get('/api/tax/classification-queue?entityId=999999&year=2025');
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('GET /api/tax/classification-queue returns 404 when querying another household entity', async () => {
  const models = await import('../../src/models/index.js');
  const { hashPassword } = await import('../../src/auth/password.js');
  const ts = Date.now();

  // Seed a second household with its own personal entity
  const password2 = await hashPassword('password456');
  const user2 = await models.User.create({
    email: `cq-hh2-${ts}@example.com`,
    displayName: 'CQ HH2 User',
    globalRole: 'user',
    passwordHash: password2.hash,
    passwordSalt: password2.salt,
    passwordParams: password2.params,
  });
  const household2 = await models.Household.create({ name: 'CQ HH2' });
  await models.HouseholdMember.create({
    householdId: household2.id,
    userId: user2.id,
    role: 'owner',
  });
  const personalEntity2 = await models.Entity.create({
    householdId: household2.id,
    kind: 'personal',
    legalName: 'Other Person',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  } as never);

  // Use the FIRST household's session to query the second household's entity
  const res = await authed.get(
    `/api/tax/classification-queue?entityId=${personalEntity2.id}&year=2025`,
  );
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
});
