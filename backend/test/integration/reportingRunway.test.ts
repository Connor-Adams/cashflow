import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let token: string;
let tokenEmpty: string;

before(async () => {
  testDb = await setupPgTestDb('reporting-runway');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  authed = request.agent(app);
  const reg = await authed.post('/api/auth/register').send({
    email: 'rep-runway@example.com',
    displayName: 'Runway',
    password: 'password123',
  });
  assert.equal(reg.status, 201);
  const mint = await authed.post('/api/v1/tokens').send({ label: 'R' });
  assert.equal(mint.status, 201);
  token = mint.body.plaintext;

  // Account with spend transactions
  const accRes = await authed.post('/api/accounts').send({
    name: 'Chequing', accountType: 'checking', defaultCurrency: 'CAD',
  });
  assert.equal(accRes.status, 201);
  const accountId: number = accRes.body.id;

  const { Transaction: TxnModel, Account: AccModel } = await import('../../src/models/index.js');
  const acc = await AccModel.findByPk(accountId);
  if (acc) {
    for (let i = 0; i < 3; i++) {
      const month = String(i + 1).padStart(2, '0');
      // Essential expense (groceries)
      await TxnModel.create({
        accountId, householdId: acc.householdId,
        date: `2025-${month}-10`, amount: -300, currency: 'CAD',
        merchantRaw: 'Grocery Store', merchantClean: 'Grocery Store',
        importBatch: `batch-rwy-g-${i}`, sourceRowFingerprint: `rfp-rwy-g-${i}`,
        sourceIdentityFingerprint: `ifp-rwy-g-${i}`,
        finalCategory: 'groceries',
        finalSplitType: 'all_mine', finalBusiness: false, reviewFlag: false, txnType: 'purchase',
      });
      // Lifestyle expense (entertainment)
      await TxnModel.create({
        accountId, householdId: acc.householdId,
        date: `2025-${month}-20`, amount: -200, currency: 'CAD',
        merchantRaw: 'Netflix', merchantClean: 'Netflix',
        importBatch: `batch-rwy-e-${i}`, sourceRowFingerprint: `rfp-rwy-e-${i}`,
        sourceIdentityFingerprint: `ifp-rwy-e-${i}`,
        finalCategory: 'entertainment',
        finalSplitType: 'all_mine', finalBusiness: false, reviewFlag: false, txnType: 'purchase',
      });
    }
  }

  // Empty household for null-guard test
  const emptyAgent = request.agent(app);
  await emptyAgent.post('/api/auth/register').send({
    email: 'rep-runway-empty@example.com',
    displayName: 'Empty', password: 'password123',
  });
  const mintE = await emptyAgent.post('/api/v1/tokens').send({ label: 'E' });
  tokenEmpty = mintE.body.plaintext;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/v1/runway returns all six fields', async () => {
  const res = await request(app).get('/api/v1/runway').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(typeof body.liquidCash === 'number');
  assert.ok(typeof body.averageMonthlyBurn === 'number');
  assert.ok(typeof body.essentialMonthlyBurn === 'number');
  assert.ok(typeof body.lifestyleMonthlyBurn === 'number');
  assert.ok('runwayMonths' in body);
  assert.ok('conservativeRunwayMonths' in body);
});

test('essentialMonthlyBurn + lifestyleMonthlyBurn == averageMonthlyBurn (within rounding)', async () => {
  const res = await request(app).get('/api/v1/runway').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const { averageMonthlyBurn, essentialMonthlyBurn, lifestyleMonthlyBurn } = res.body;
  assert.ok(
    Math.abs(essentialMonthlyBurn + lifestyleMonthlyBurn - averageMonthlyBurn) < 0.05,
    `${essentialMonthlyBurn} + ${lifestyleMonthlyBurn} should ≈ ${averageMonthlyBurn}`,
  );
});

test('GET /api/v1/runway with zero burn returns runwayMonths: null', async () => {
  const res = await request(app).get('/api/v1/runway').set('Authorization', `Bearer ${tokenEmpty}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.runwayMonths, null);
  assert.equal(res.body.conservativeRunwayMonths, null);
});
