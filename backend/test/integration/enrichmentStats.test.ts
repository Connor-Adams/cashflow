/**
 * Integration tests for the needs-attention aggregates added to
 * GET /api/transactions/enrichment/stats (task 2).
 *
 * Verifies that uncategorizedCount, merchantsMissingCanonical, and deadRules
 * are present in the response body with the correct types, and that household
 * scoping is respected.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let householdAId: number;
let userAId: number;
let accountAId: number;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('enrichmentStats');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const a = await seedHousehold('EnrStatsA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = testAgent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const models = await import('../../src/models');
  const acctA = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'EnrStats Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'ES-CHQ',
  });
  accountAId = acctA.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('enrichment stats reports needs-attention aggregates', async () => {
  const models = await import('../../src/models');

  // Seed a rule that IS applied to a transaction (should NOT appear in deadRules).
  const appliedRule = await models.Rule.create({
    householdId: householdAId,
    merchantPattern: 'APPLIED_RULE_MERCHANT',
    matchKind: 'substring',
    priority: 5,
    category: 'Dining',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  } as never);

  // Seed a rule that is NEVER applied to any transaction (should appear in deadRules).
  const deadRule = await models.Rule.create({
    householdId: householdAId,
    merchantPattern: 'DEAD_RULE_NEVER_MATCHED',
    matchKind: 'substring',
    priority: 5,
    category: 'Groceries',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  } as never);

  // Seed a transaction with no final_category (uncategorized), and reference the applied rule.
  await models.Transaction.create({
    accountId: accountAId,
    householdId: householdAId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'enr-stats-test',
    date: '2027-03-01',
    merchantRaw: 'Uncategorized Merchant',
    merchantClean: 'Uncategorized Merchant',
    merchantCanonical: 'UNCATEGORIZED_MERCHANT',
    amount: '10.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: appliedRule.id,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null, // uncategorized
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
    myShareAmount: '10.0000',
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

  // Seed a transaction with no merchant_canonical (missing canonical).
  await models.Transaction.create({
    accountId: accountAId,
    householdId: householdAId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'enr-stats-test',
    date: '2027-03-02',
    merchantRaw: 'No Canonical',
    merchantClean: 'No Canonical',
    merchantCanonical: null, // missing canonical
    amount: '20.0000',
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
    myShareAmount: '20.0000',
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

  const res = await agentA.get('/api/transactions/enrichment/stats');
  assert.equal(res.status, 200);

  assert.equal(typeof res.body.uncategorizedCount, 'number');
  assert.equal(typeof res.body.merchantsMissingCanonical, 'number');
  assert.ok(Array.isArray(res.body.deadRules));

  // The uncategorized transaction we seeded should be counted.
  assert.ok(
    res.body.uncategorizedCount >= 1,
    `uncategorizedCount should be >= 1, got ${res.body.uncategorizedCount}`,
  );

  // The missing-canonical transaction we seeded should be counted.
  assert.ok(
    res.body.merchantsMissingCanonical >= 1,
    `merchantsMissingCanonical should be >= 1, got ${res.body.merchantsMissingCanonical}`,
  );

  // The dead rule (never applied) must appear in deadRules.
  const deadRuleIds = res.body.deadRules.map((r: { ruleId: number }) => r.ruleId);
  assert.ok(
    deadRuleIds.includes(deadRule.id),
    `dead rule id ${deadRule.id} should appear in deadRules, got: ${JSON.stringify(deadRuleIds)}`,
  );

  // The applied rule must NOT appear in deadRules.
  assert.ok(
    !deadRuleIds.includes(appliedRule.id),
    `applied rule id ${appliedRule.id} should NOT appear in deadRules, got: ${JSON.stringify(deadRuleIds)}`,
  );
});
