/**
 * Integration tests for the rules health dashboard endpoints introduced in
 * issue #206:
 *   - GET /api/rules/health
 *   - GET /api/rules/suggestions
 *
 * The health endpoint surfaces rule-coverage metrics for the caller's
 * household: hit rate (% of recent txns that hit a rule), uncategorized
 * count, review-flag count, stale rules (no match within the window),
 * duplicate rules (same merchantPattern + matchKind), and top merchants
 * that have no rule match.
 *
 * The suggestions endpoint is a thin wrapper around the existing rule
 * proposal logic so the contract from the issue ("GET /rules/suggestions")
 * is satisfied without a second source of truth.
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
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let householdBId: number;
let userAId: number;
let userBId: number;
let accountAId: number;
let accountBId: number;
let testDb: PgTestDb;

type TxnSeed = {
  householdId: number;
  accountId: number;
  date: string;
  amount?: number;
  currency?: string;
  merchantRaw?: string;
  merchantClean?: string;
  merchantCanonical?: string | null;
  finalCategory?: string | null;
  appliedRuleId?: number | null;
  reviewFlag?: boolean;
  reviewedAt?: Date | null;
  visibility?: string;
  createdByUserId?: number | null;
  importBatch?: string;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const amount = seed.amount ?? -10;
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    visibility: seed.visibility ?? 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: seed.importBatch ?? 'rules-health-test',
    date: seed.date,
    merchantRaw: seed.merchantRaw ?? 'Test Merchant',
    merchantClean: seed.merchantClean ?? seed.merchantRaw ?? 'Test Merchant',
    merchantCanonical: seed.merchantCanonical ?? null,
    amount: amount.toFixed(4),
    currency: seed.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: seed.appliedRuleId ?? null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: seed.finalCategory ?? null,
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
    myShareAmount: String(amount),
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: seed.reviewFlag ?? false,
    reviewedAt: seed.reviewedAt ?? null,
    createdByUserId: seed.createdByUserId ?? null,
  });
  return row.id;
}

async function createRule(opts: {
  householdId: number;
  merchantPattern: string;
  matchKind?: string;
  category?: string | null;
  priority?: number;
  createdByUserId?: number | null;
}): Promise<number> {
  const { Rule } = await import('../../src/models');
  const row = await Rule.create({
    householdId: opts.householdId,
    createdByUserId: opts.createdByUserId ?? null,
    merchantPattern: opts.merchantPattern,
    matchKind: opts.matchKind ?? 'substring',
    priority: opts.priority ?? 0,
    category: opts.category ?? null,
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
  });
  return row.id;
}

const today = '2026-05-26';
const ninetyDaysAgo = '2026-02-25';
const longAgo = '2025-10-01';

before(async () => {
  testDb = await setupPgTestDb('rules-health');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // First-registered user becomes superadmin; we don't drive that agent.
  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'super-rules-health@example.com',
    displayName: 'Super',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('RulesHealthA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = testAgent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('RulesHealthB', 'B Partner');
  householdBId = b.householdId;
  userBId = b.userId;
  agentB = testAgent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);

  const models = await import('../../src/models');
  const acctA = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'A-CHQ',
  });
  accountAId = acctA.id;
  const acctB = await models.Account.create({
    householdId: householdBId,
    ownerUserId: userBId,
    owner: 'me',
    visibility: 'shared',
    name: 'B Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'B-CHQ',
  });
  accountBId = acctB.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---------------- /api/rules/health ----------------

test('GET /api/rules/health returns zero metrics when household is empty', async () => {
  const res = await agentA.get('/api/rules/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.totalRules, 0);
  assert.equal(res.body.totalTransactions, 0);
  assert.equal(res.body.hitRate, 0);
  assert.equal(res.body.hitCount, 0);
  assert.equal(res.body.uncategorizedCount, 0);
  assert.equal(res.body.reviewFlagCount, 0);
  assert.deepEqual(res.body.staleRules, []);
  assert.deepEqual(res.body.duplicateRules, []);
  assert.deepEqual(res.body.topMerchantsWithoutRules, []);
  assert.equal(typeof res.body.windowDays, 'number');
});

test('GET /api/rules/health computes hitRate, uncategorized, reviewFlag counts', async () => {
  const ruleId = await createRule({
    householdId: householdAId,
    merchantPattern: 'NETFLIX',
    category: 'Subscriptions',
    createdByUserId: userAId,
  });
  // 4 transactions: 2 hit the rule, 1 uncategorized, 1 review flag.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: today,
    merchantCanonical: 'Netflix',
    finalCategory: 'Subscriptions',
    appliedRuleId: ruleId,
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: today,
    merchantCanonical: 'Netflix',
    finalCategory: 'Subscriptions',
    appliedRuleId: ruleId,
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: today,
    merchantCanonical: 'Tim Hortons',
    finalCategory: null,
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: today,
    merchantCanonical: 'Mystery Charge',
    finalCategory: null,
    reviewFlag: true,
  });

  const res = await agentA.get('/api/rules/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.totalRules, 1);
  assert.equal(res.body.totalTransactions, 4);
  assert.equal(res.body.hitCount, 2);
  assert.equal(res.body.hitRate, 0.5);
  assert.equal(res.body.uncategorizedCount, 2);
  assert.equal(res.body.reviewFlagCount, 1);
});

test('GET /api/rules/health flags stale rules with no match in the window', async () => {
  // Rule "OLD-STORE" only matched once before the 90-day window; should be stale.
  const staleId = await createRule({
    householdId: householdAId,
    merchantPattern: 'OLD-STORE',
    category: 'Groceries',
    createdByUserId: userAId,
  });
  // Rule "NEVER-USED" has zero transactions; should also be stale.
  const neverUsedId = await createRule({
    householdId: householdAId,
    merchantPattern: 'NEVER-USED',
    category: 'Misc',
    createdByUserId: userAId,
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: longAgo,
    merchantCanonical: 'Old Store',
    appliedRuleId: staleId,
  });

  const res = await agentA.get('/api/rules/health');
  assert.equal(res.status, 200);
  const staleIds = (res.body.staleRules as Array<{ id: number }>).map((r) => r.id);
  assert.ok(staleIds.includes(staleId), 'stale rule must appear');
  assert.ok(staleIds.includes(neverUsedId), 'never-used rule must appear');
  // NETFLIX rule has recent hits, must NOT be stale.
  const stale = res.body.staleRules as Array<{ id: number; merchantPattern: string; lastMatchedAt: string | null }>;
  const staleRow = stale.find((r) => r.id === staleId);
  assert.ok(staleRow);
  assert.equal(staleRow.merchantPattern, 'OLD-STORE');
  assert.ok(staleRow.lastMatchedAt != null, 'stale rule with a match should expose lastMatchedAt');
  const neverRow = stale.find((r) => r.id === neverUsedId);
  assert.ok(neverRow);
  assert.equal(neverRow.lastMatchedAt, null);
});

test('GET /api/rules/health flags duplicate rules (same pattern + matchKind)', async () => {
  // Identical patterns in the same household — should appear in duplicateRules.
  await createRule({
    householdId: householdAId,
    merchantPattern: 'DUPLICATE-PATTERN',
    matchKind: 'substring',
    category: 'A',
    createdByUserId: userAId,
  });
  await createRule({
    householdId: householdAId,
    merchantPattern: 'duplicate-pattern',
    matchKind: 'substring',
    category: 'B',
    createdByUserId: userAId,
    priority: 10,
  });

  const res = await agentA.get('/api/rules/health');
  assert.equal(res.status, 200);
  const duplicates = res.body.duplicateRules as Array<{
    merchantPattern: string;
    matchKind: string;
    ruleIds: number[];
  }>;
  const dupRow = duplicates.find(
    (d) => d.merchantPattern.toLowerCase() === 'duplicate-pattern' && d.matchKind === 'substring'
  );
  assert.ok(dupRow, 'duplicate row should be present');
  assert.equal(dupRow.ruleIds.length, 2);
});

test('GET /api/rules/health surfaces top merchants without rules', async () => {
  // 3 transactions for "Coffee Shop" without a rule → should be a top suggestion.
  for (let i = 0; i < 3; i++) {
    await createTxn({
      householdId: householdAId,
      accountId: accountAId,
      date: today,
      merchantCanonical: 'Coffee Shop',
      finalCategory: 'Dining',
    });
  }
  const res = await agentA.get('/api/rules/health');
  assert.equal(res.status, 200);
  const tops = res.body.topMerchantsWithoutRules as Array<{
    merchantCanonical: string;
    count: number;
  }>;
  const coffee = tops.find((t) => t.merchantCanonical === 'Coffee Shop');
  assert.ok(coffee, 'Coffee Shop should appear in topMerchantsWithoutRules');
  assert.ok(coffee.count >= 3);
  // Netflix has a rule and must NOT appear.
  assert.ok(
    !tops.find((t) => t.merchantCanonical === 'Netflix'),
    'merchant with a rule must not appear in topMerchantsWithoutRules'
  );
});

test('GET /api/rules/health is household-scoped', async () => {
  // Household B has zero rules / txns; must NOT see anything from A.
  const res = await agentB.get('/api/rules/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.totalRules, 0);
  assert.equal(res.body.totalTransactions, 0);
  assert.equal(res.body.hitCount, 0);
  assert.deepEqual(res.body.staleRules, []);
  assert.deepEqual(res.body.duplicateRules, []);
  assert.deepEqual(res.body.topMerchantsWithoutRules, []);
});

// ---------------- /api/rules/suggestions ----------------

test('GET /api/rules/suggestions returns empty array for empty household', async () => {
  const res = await agentB.get('/api/rules/suggestions');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { suggestions: [] });
});

test('GET /api/rules/suggestions proposes rules for repeated reviewed merchants', async () => {
  // Need >=3 reviewed transactions sharing merchantClean+category/etc., no
  // existing rule for that pattern. Use a fresh merchant.
  for (let i = 0; i < 4; i++) {
    await createTxn({
      householdId: householdBId,
      accountId: accountBId,
      date: today,
      merchantClean: 'STARBUCKS COFFEE',
      merchantCanonical: 'Starbucks',
      finalCategory: 'Dining',
      reviewedAt: new Date(),
    });
  }

  const res = await agentB.get('/api/rules/suggestions');
  assert.equal(res.status, 200);
  const suggestions = res.body.suggestions as Array<{
    merchantPattern: string;
    category: string | null;
    supportCount: number;
  }>;
  const starbucks = suggestions.find((s) => s.merchantPattern === 'STARBUCKS COFFEE');
  assert.ok(starbucks, 'STARBUCKS COFFEE should be proposed');
  assert.equal(starbucks.category, 'Dining');
  assert.ok(starbucks.supportCount >= 4);
});
