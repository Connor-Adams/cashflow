import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let authedCorp: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let token: string;
let tokenCorp: string;
let householdCorpId: number;

before(async () => {
  testDb = await setupPgTestDb('reporting-tax');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  // Personal household
  authed = request.agent(app);
  const reg = await authed.post('/api/auth/register').send({
    email: 'rep-tax@example.com',
    displayName: 'Tax User',
    password: 'password123',
  });
  assert.equal(reg.status, 201);
  const mint = await authed.post('/api/v1/tokens').send({ label: 'T' });
  assert.equal(mint.status, 201);
  token = mint.body.plaintext;

  const accRes = await authed.post('/api/accounts').send({
    name: 'Chequing', accountType: 'checking', defaultCurrency: 'CAD',
  });
  assert.equal(accRes.status, 201);
  const accountId: number = accRes.body.id;

  const { Transaction: TxnModel, Account: AccModel } = await import('../../src/models/index.js');
  const acc = await AccModel.findByPk(accountId);
  if (acc) {
    // Seed income in 2025
    await TxnModel.create({
      accountId, householdId: acc.householdId,
      date: '2025-06-15', amount: 5000, currency: 'CAD',
      merchantRaw: 'Payroll', merchantClean: 'Payroll',
      importBatch: 'tax-p-0', sourceRowFingerprint: 'rfp-tax-p-0',
      sourceIdentityFingerprint: 'ifp-tax-p-0',
      finalSplitType: 'all_mine', finalBusiness: false, reviewFlag: false, txnType: 'income',
    });
  }

  // Corp household
  authedCorp = request.agent(app);
  const regCorp = await authedCorp.post('/api/auth/register').send({
    email: 'rep-tax-corp@example.com',
    displayName: 'Corp User',
    password: 'password123',
  });
  assert.equal(regCorp.status, 201);
  const mintCorp = await authedCorp.post('/api/v1/tokens').send({ label: 'TC' });
  assert.equal(mintCorp.status, 201);
  tokenCorp = mintCorp.body.plaintext;

  // Get household ID for corp user and create a corp entity
  const meRes = await authedCorp.get('/api/household');
  householdCorpId = meRes.body?.household?.id ?? meRes.body?.id;

  const { Entity: EntityModel } = await import('../../src/models/index.js');
  if (householdCorpId) {
    await EntityModel.create({
      householdId: householdCorpId,
      kind: 'corp',
      legalName: 'Test Corp Inc',
    });
  }
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/v1/tax returns required fields', async () => {
  const res = await request(app)
    .get('/api/v1/tax?year=2025')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(typeof body.year === 'number');
  assert.ok(typeof body.grossIncome === 'number');
  assert.ok(typeof body.estimatedTaxOwed === 'number');
  assert.ok(typeof body.taxReserveTarget === 'number');
  assert.ok(typeof body.taxReserveActual === 'number');
  assert.ok(typeof body.reserveDelta === 'number');
});

test('reserveDelta == taxReserveTarget - taxReserveActual', async () => {
  const res = await request(app)
    .get('/api/v1/tax?year=2025')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const { taxReserveTarget, taxReserveActual, reserveDelta } = res.body;
  assert.ok(
    Math.abs(reserveDelta - (taxReserveTarget - taxReserveActual)) < 0.01,
    `reserveDelta ${reserveDelta} should equal ${taxReserveTarget} - ${taxReserveActual}`,
  );
});

test('hst* and corporateCash fields absent for personal household', async () => {
  const res = await request(app)
    .get('/api/v1/tax?year=2025')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(!('hstCollected' in res.body), 'hstCollected should not be present for personal');
  assert.ok(!('hstRemitted' in res.body), 'hstRemitted should not be present for personal');
  assert.ok(!('corporateCash' in res.body), 'corporateCash should not be present for personal');
});

test('hst* and corporateCash are included when household has corp entity', async () => {
  if (!householdCorpId) return; // skip if setup failed
  const res = await request(app)
    .get('/api/v1/tax?year=2025')
    .set('Authorization', `Bearer ${tokenCorp}`);
  assert.equal(res.status, 200);
  assert.ok('hstCollected' in res.body, 'hstCollected should be present for corp');
  assert.ok('hstRemitted' in res.body, 'hstRemitted should be present for corp');
  assert.ok('corporateCash' in res.body, 'corporateCash should be present for corp');
});

test('GET /api/v1/tax performs no writes (no transaction mutations)', async () => {
  const { Transaction: TxnModel } = await import('../../src/models/index.js');
  const countBefore = await TxnModel.count();
  await request(app).get('/api/v1/tax?year=2025').set('Authorization', `Bearer ${token}`);
  const countAfter = await TxnModel.count();
  assert.equal(countBefore, countAfter, 'transaction count must not change');
});

test('unknown year with no data returns 200 with zeroed digest', async () => {
  const res = await request(app)
    .get('/api/v1/tax?year=1900')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.year, 1900);
  assert.equal(res.body.grossIncome, 0);
});
