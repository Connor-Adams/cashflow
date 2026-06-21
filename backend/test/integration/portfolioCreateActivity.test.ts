/**
 * Integration tests for POST /api/portfolio/activities (issue #301).
 *
 * Covers the manual corporate-action entry endpoint: per-type validation,
 * persistence with synthesized manual provenance, the ACB effect visible via
 * the per-security drill, and the cross-security basis injection for spin_off
 * and merger (a transfer_in written onto the recipient security's stream).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;
let acctId: number;
let parentSecId: number;
let childSecId: number;
let otherHouseholdSecId: number;

const APPROX = (a: number, b: number, eps = 1e-4) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

before(async () => {
  testDb = await setupPgTestDb('create-activity');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models');
  const { seedHousehold, seedAccount, seedSecurity, seedActivity } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `mkact-${Date.now()}@example.com`);
  householdId = seeded.household.id;
  userId = seeded.user.id;
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);

  const acct = await seedAccount(models, householdId, userId, 'TFSA', 'TFSAMK');
  acctId = acct.id;
  const parent = await seedSecurity(models, householdId, 'PRNT', 'Parent Co', 'EQUITY');
  const child = await seedSecurity(models, householdId, 'CHLD', 'Child Co', 'EQUITY');
  parentSecId = parent.id;
  childSecId = child.id;

  // Parent starting position: BUY 10 @ $1000 → ACB $100/share, totalCost $1000.
  await seedActivity(models, {
    accountId: acctId,
    householdId,
    securityId: parentSecId,
    activityType: 'buy',
    tradeDate: '2024-01-15',
    quantity: 10,
    amount: 1000,
  });

  // A security belonging to a different household — used to assert scoping.
  const other = await seedHousehold(models, `mkact-other-${Date.now()}@example.com`);
  const otherSec = await seedSecurity(models, other.household.id, 'OTHR', 'Other Co', 'EQUITY');
  otherHouseholdSecId = otherSec.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('dividend_in_kind: 201 and the per-unit ACB drops on the drill', async () => {
  const res = await authed
    .post('/api/portfolio/activities')
    .send({
      accountId: acctId,
      securityId: parentSecId,
      activityType: 'dividend_in_kind',
      tradeDate: '2024-03-01',
      quantity: 2,
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.activity.activityType, 'dividend_in_kind');

  const drill = await authed.get(`/api/portfolio/security/${parentSecId}`);
  assert.equal(drill.status, 200);
  // totalCost still 1000 across 12 shares → ACB ≈ 83.3333.
  const acb = drill.body.perAccount[0].acb;
  APPROX(acb.finalState.quantity, 12);
  APPROX(acb.finalState.totalCost, 1000);
  APPROX(acb.finalState.acbPerUnit, 1000 / 12);
});

test('spin_off: 201, parent basis reduced, recipient transfer_in created with allocated basis', async () => {
  // Parent pre-action totalCost is 1000 (the dividend_in_kind above did not
  // change it). Allocate 30% → recipient gets $300; parent keeps $700.
  const res = await authed
    .post('/api/portfolio/activities')
    .send({
      accountId: acctId,
      securityId: parentSecId,
      activityType: 'spin_off',
      tradeDate: '2024-04-01',
      quantity: 5, // recipient shares received
      recipientSecurityId: childSecId,
      costBasisAllocationPct: 0.3,
    });
  assert.equal(res.status, 201);
  assert.ok(res.body.recipientActivity, 'recipient activity should be returned');
  assert.equal(res.body.recipientActivity.securityId, childSecId);

  const parentDrill = await authed.get(`/api/portfolio/security/${parentSecId}`);
  APPROX(parentDrill.body.perAccount[0].acb.finalState.totalCost, 700);

  const childDrill = await authed.get(`/api/portfolio/security/${childSecId}`);
  // Recipient got 5 shares at $300 book cost → ACB $60/share.
  const childAcb = childDrill.body.perAccount[0].acb;
  APPROX(childAcb.finalState.quantity, 5);
  APPROX(childAcb.finalState.totalCost, 300);
  APPROX(childAcb.finalState.acbPerUnit, 60);
});

test('merger: 201, source disposed (cash as proceeds), recipient gets residual basis', async () => {
  // Fresh account + securities so the math is isolated from the above.
  const models = await import('../../src/models');
  const { seedAccount, seedSecurity, seedActivity } = await import('./portfolioFixtures.js');
  const acct2 = await seedAccount(models, householdId, userId, 'RRSP', 'RRSPMK');
  const src = await seedSecurity(models, householdId, 'SRCM', 'Source M', 'EQUITY');
  const dst = await seedSecurity(models, householdId, 'DSTM', 'Dest M', 'EQUITY');
  await seedActivity(models, {
    accountId: acct2.id,
    householdId,
    securityId: src.id,
    activityType: 'buy',
    tradeDate: '2024-01-15',
    quantity: 10,
    amount: 1000, // totalCost $1000
  });

  const res = await authed
    .post('/api/portfolio/activities')
    .send({
      accountId: acct2.id,
      securityId: src.id,
      activityType: 'merger',
      tradeDate: '2024-06-01',
      quantity: 8, // recipient shares received
      recipientSecurityId: dst.id,
      cashComponent: 5, // $5/share cash on the 10 source shares → $50 proceeds
    });
  assert.equal(res.status, 201);
  assert.ok(res.body.recipientActivity);

  const srcDrill = await authed.get(`/api/portfolio/security/${src.id}`);
  const srcAcb = srcDrill.body.perAccount[0].acb;
  APPROX(srcAcb.finalState.quantity, 0); // disposed
  APPROX(srcAcb.realizedTotal, 50 - 1000); // cash proceeds minus removed cost

  const dstDrill = await authed.get(`/api/portfolio/security/${dst.id}`);
  const dstAcb = dstDrill.body.perAccount[0].acb;
  // Residual basis = 1000 - 50 = 950 over 8 shares.
  APPROX(dstAcb.finalState.quantity, 8);
  APPROX(dstAcb.finalState.totalCost, 950);
});

test('return_of_capital: 201; ROC exceeding basis surfaces a deemed gain', async () => {
  const models = await import('../../src/models');
  const { seedAccount, seedSecurity, seedActivity } = await import('./portfolioFixtures.js');
  const acct3 = await seedAccount(models, householdId, userId, 'NREG', 'NREGMK');
  const sec = await seedSecurity(models, householdId, 'ROCS', 'ROC Sec', 'EQUITY');
  await seedActivity(models, {
    accountId: acct3.id,
    householdId,
    securityId: sec.id,
    activityType: 'buy',
    tradeDate: '2024-01-15',
    quantity: 10,
    amount: 1000, // totalCost $1000
  });

  const res = await authed
    .post('/api/portfolio/activities')
    .send({
      accountId: acct3.id,
      securityId: sec.id,
      activityType: 'return_of_capital',
      tradeDate: '2024-06-01',
      amount: 1200, // exceeds the $1000 basis → $200 deemed gain
    });
  assert.equal(res.status, 201);

  const drill = await authed.get(`/api/portfolio/security/${sec.id}`);
  const acb = drill.body.perAccount[0].acb;
  APPROX(acb.finalState.totalCost, 0);
  APPROX(acb.realizedTotal, 200); // the deemed gain
});

test('validation: bad allocation returns 400 SPINOFF_ALLOCATION_OUT_OF_RANGE', async () => {
  const res = await authed
    .post('/api/portfolio/activities')
    .send({
      accountId: acctId,
      securityId: parentSecId,
      activityType: 'spin_off',
      tradeDate: '2024-07-01',
      quantity: 1,
      recipientSecurityId: childSecId,
      costBasisAllocationPct: 1.5,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'SPINOFF_ALLOCATION_OUT_OF_RANGE');
});

test('validation: dividend_in_kind without shares returns 400', async () => {
  const res = await authed
    .post('/api/portfolio/activities')
    .send({
      accountId: acctId,
      securityId: parentSecId,
      activityType: 'dividend_in_kind',
      tradeDate: '2024-07-01',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'DIVIDEND_IN_KIND_REQUIRES_SHARES');
});

test('scoping: recipient security from another household is rejected', async () => {
  const res = await authed
    .post('/api/portfolio/activities')
    .send({
      accountId: acctId,
      securityId: parentSecId,
      activityType: 'spin_off',
      tradeDate: '2024-08-01',
      quantity: 1,
      recipientSecurityId: otherHouseholdSecId,
      costBasisAllocationPct: 0.1,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'RECIPIENT_SECURITY_NOT_FOUND');
});

test('scoping: account from another household is rejected', async () => {
  const res = await authed
    .post('/api/portfolio/activities')
    .send({
      accountId: 999999,
      securityId: parentSecId,
      activityType: 'dividend_in_kind',
      tradeDate: '2024-08-01',
      quantity: 1,
    });
  assert.equal(res.status, 404);
});
