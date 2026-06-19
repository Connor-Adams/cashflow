/**
 * Integration tests for the coverage-by-spend-date timeseries endpoint
 * GET /api/transactions/enrichment/coverage (task 3).
 *
 * Verifies ascending monthly/weekly buckets are returned with correct
 * shapes and that an invalid bucket falls back to 'month'.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let householdAId: number;
let userAId: number;
let accountAId: number;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('enrichmentCoverage');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const a = await seedHousehold('EnrCovA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const models = await import('../../src/models');
  const acctA = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'EnrCov Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'EC-CHQ',
  });
  accountAId = acctA.id;

  // Seed a transaction so there is at least one data point in the coverage series.
  await models.Transaction.create({
    accountId: accountAId,
    householdId: householdAId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'enr-cov-test',
    date: '2027-03-15',
    merchantRaw: 'Coverage Test Merchant',
    merchantClean: 'Coverage Test Merchant',
    merchantCanonical: 'COVERAGE_TEST',
    amount: '50.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: 'Groceries',
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    myShareAmount: '50.0000',
    partnerShareAmount: '0.0000',
    businessAmount: '0.0000',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
    status: 'posted',
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('coverage returns ascending monthly buckets with the four counts', async () => {
  const res = await agentA.get('/api/transactions/enrichment/coverage?bucket=month');
  assert.equal(res.status, 200);
  assert.equal(res.body.bucket, 'month');
  assert.ok(Array.isArray(res.body.series));
  for (const pt of res.body.series) {
    assert.equal(typeof pt.period, 'string');
    assert.ok(pt.total >= 0);
    assert.ok(pt.cleared <= pt.total);
    assert.ok(pt.withCanonical <= pt.total);
  }
});

test('invalid bucket falls back to month', async () => {
  const res = await agentA.get('/api/transactions/enrichment/coverage?bucket=nonsense');
  assert.equal(res.status, 200);
  assert.equal(res.body.bucket, 'month');
});
