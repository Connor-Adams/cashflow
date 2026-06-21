/**
 * Integration tests for the data-quality dashboard API (#234).
 *
 *   GET /api/data-quality
 *
 * Exercises each of the seven component signals against a seeded household
 * and verifies:
 *   1. Empty dataset returns a vacuous perfect score.
 *   2. Each component's count + coverage matches the seeded shape.
 *   3. Overall score equals the unweighted mean of component scores.
 *   4. Cross-household isolation: another household's data never bleeds in.
 *   5. Score updates after categorization / receipts / rules / review
 *      resolution (the "score updates after X" AC bullet).
 *
 * Mirrors the receiptCompleteness integration-test setup pattern: pg test
 * db, superadmin bootstrap, two non-superadmin households so the visibility
 * rules are exercised by real session cookies.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryUserId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let otherUserId: number;
let primaryAccountId: number;
let otherAccountId: number;
let testDb: PgTestDb;

type Seeded = { token: string; householdId: number; userId: number; accountId: number };

async function seed(emailPrefix: string): Promise<Seeded> {
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: emailPrefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: `${emailPrefix} household` });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const account = await models.Account.create({
    householdId: household.id,
    ownerUserId: user.id,
    owner: 'me',
    visibility: 'shared',
    name: `${emailPrefix} card`,
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, householdId: household.id, userId: user.id, accountId: account.id };
}

type TxOverrides = {
  visibility?: string;
  createdByUserId?: number | null;
  ownershipType?: string;
  finalBusiness?: boolean;
  finalCategory?: string | null;
  txnType?: string;
  reviewFlag?: boolean;
  appliedRuleId?: number | null;
  linkedTransactionId?: number | null;
  merchantClean?: string;
};

async function createTransaction(
  householdId: number,
  accountId: number,
  date: string,
  category: string | null,
  amount: number,
  currency = 'CAD',
  overrides: TxOverrides = {}
): Promise<number> {
  const models = await import('../../src/models');
  const merchant = overrides.merchantClean ?? 'Test Merchant';
  const row = await models.Transaction.create({
    accountId,
    householdId,
    visibility: overrides.visibility ?? 'shared',
    ownershipType: overrides.ownershipType ?? 'me',
    ownershipContactId: null,
    importBatch: 'dq-test',
    date,
    merchantRaw: merchant,
    merchantClean: merchant,
    amount: amount.toFixed(4),
    currency,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: overrides.appliedRuleId ?? null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: overrides.finalCategory !== undefined ? overrides.finalCategory : category,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: overrides.finalBusiness ?? false,
    autoSplitType: null,
    splitOverride: null,
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: overrides.reviewFlag ?? false,
    reviewedAt: null,
    createdByUserId: overrides.createdByUserId ?? null,
    txnType: overrides.txnType ?? 'purchase',
    linkedTransactionId: overrides.linkedTransactionId ?? null,
  });
  return row.id;
}

async function attachReceipt(transactionId: number): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Receipt.create({
    transactionId,
    storedFilename: `${crypto.randomBytes(8).toString('hex')}.jpg`,
    originalName: 'r.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1234,
    extractedNote: null,
  });
  return row.id;
}

// Map a legacy Subscription status to the merged PlannedEvent (kind='subscription')
// status + statusUncertain pair. Mirrors fromSubscriptionStatus in
// src/expectations/subscriptionMapper.ts so the data-quality reader (which
// counts statusUncertain=true rows as "stale") sees equivalent state.
function subscriptionStatusFields(
  status: 'active' | 'cancelled' | 'ignored' | 'unknown',
): { status: 'planned' | 'cancelled' | 'ignored'; statusUncertain: boolean } {
  switch (status) {
    case 'cancelled':
      return { status: 'cancelled', statusUncertain: false };
    case 'ignored':
      return { status: 'ignored', statusUncertain: false };
    case 'unknown':
      return { status: 'planned', statusUncertain: true };
    case 'active':
    default:
      return { status: 'planned', statusUncertain: false };
  }
}

async function ownerUserId(householdId: number): Promise<number> {
  const models = await import('../../src/models');
  return (
    await models.HouseholdMember.findOne({
      where: { householdId, role: 'owner' },
      attributes: ['userId'],
      raw: true,
    })
  )!.userId;
}

async function createSubscription(
  householdId: number,
  status: 'active' | 'cancelled' | 'ignored' | 'unknown',
  merchant: string,
): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.PlannedEvent.create({
    kind: 'subscription',
    type: 'expense',
    source: 'recurring_detection',
    userId: await ownerUserId(householdId),
    householdId,
    name: merchant,
    normalizedName: merchant.toLowerCase(),
    amount: '10.00',
    currency: 'CAD',
    cadence: 'monthly',
    lastChargeDate: '2026-05-01',
    nextExpectedDate: '2026-06-01',
    expectedDate: '2026-06-01',
    category: null,
    annualizedCost: '120.00',
    cancellationUrl: null,
    notes: null,
    ...subscriptionStatusFields(status),
  });
  return row.id;
}

async function createRule(householdId: number, userId: number): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Rule.create({
    merchantPattern: 'Acme',
    householdId,
    createdByUserId: userId,
    matchKind: 'contains',
    priority: 1,
    category: 'Groceries',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('dquality');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryUserId = primary.userId;
  primaryAccountId = primary.accountId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherUserId = other.userId;
  otherAccountId = other.accountId;
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/data-quality on empty dataset returns vacuous perfect score', async () => {
  const res = await primaryAgent.get('/api/data-quality');
  assert.equal(res.status, 200);
  assert.equal(res.body.score, 1);
  assert.equal(res.body.componentScores.categorization, 1);
  assert.equal(res.body.componentScores.rules, 1);
  assert.equal(res.body.componentScores.receipts, 1);
  assert.equal(res.body.componentScores.duplicates, 1);
  assert.equal(res.body.componentScores.transfers, 1);
  assert.equal(res.body.componentScores.subscriptions, 1);
  assert.equal(res.body.componentScores.review, 1);
  assert.equal(res.body.totals.transactionsScanned, 0);
  assert.equal(res.body.totals.spendTransactions, 0);
  // actionLinks is bundled so the frontend can render without hard-coding.
  assert.ok(Array.isArray(res.body.actionLinks));
  assert.equal(res.body.actionLinks.length, 7);
});

test('GET /api/data-quality: categorization + rules components count spend coverage', async () => {
  // 4 spend rows: 3 with finalCategory, 2 with appliedRuleId.
  const rule = await createRule(primaryHouseholdId, primaryUserId);
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-01',
    'Groceries',
    -100,
    'CAD',
    { createdByUserId: primaryUserId, appliedRuleId: rule },
  );
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-02',
    'Groceries',
    -200,
    'CAD',
    { createdByUserId: primaryUserId, appliedRuleId: rule },
  );
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-03',
    'Travel',
    -300,
    'CAD',
    { createdByUserId: primaryUserId },
  );
  // Uncategorized + unruled.
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-04',
    null,
    -50,
    'CAD',
    { createdByUserId: primaryUserId, finalCategory: null },
  );

  const res = await primaryAgent.get('/api/data-quality');
  assert.equal(res.status, 200);
  assert.equal(res.body.components.categorization.totalSpend, 4);
  assert.equal(res.body.components.categorization.categorized, 3);
  assert.equal(res.body.components.categorization.uncategorized, 1);
  assert.equal(res.body.components.rules.ruleCovered, 2);
  assert.equal(res.body.components.rules.uncovered, 2);
  // coverage = 3/4 = 0.75 and 2/4 = 0.5
  assert.equal(res.body.componentScores.categorization, 0.75);
  assert.equal(res.body.componentScores.rules, 0.5);
});

test('GET /api/data-quality: receipts coverage agrees with aggregateReceiptCompleteness', async () => {
  // Attach a receipt to one of the existing primary spend rows. We expect
  // receipts.withReceipt to bump to 1 of 4 spend rows.
  const models = await import('../../src/models');
  const { Op } = await import('sequelize');
  const oneSpend = await models.Transaction.findOne({
    where: { householdId: primaryHouseholdId, amount: { [Op.lt]: 0 } },
    order: [['id', 'ASC']],
  });
  assert.ok(oneSpend);
  await attachReceipt(oneSpend!.id);

  const res = await primaryAgent.get('/api/data-quality');
  assert.equal(res.body.components.receipts.withReceipt, 1);
  assert.equal(res.body.components.receipts.totalSpend, 4);
  assert.equal(res.body.componentScores.receipts, 0.25);
});

test('GET /api/data-quality: duplicate groups counted by date+amount+currency+merchant', async () => {
  // Two identical rows (date+amount+currency+merchant) → 1 duplicate group of 2.
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-10',
    'Dining',
    -25,
    'CAD',
    { createdByUserId: primaryUserId, merchantClean: 'Cafe Dupe' },
  );
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-10',
    'Dining',
    -25,
    'CAD',
    { createdByUserId: primaryUserId, merchantClean: 'Cafe Dupe' },
  );

  const res = await primaryAgent.get('/api/data-quality');
  assert.equal(res.body.components.duplicates.duplicateGroups, 1);
  assert.equal(res.body.components.duplicates.duplicateTransactions, 2);
});

test('GET /api/data-quality: unmatched transfers counted only when linkedTransactionId is null', async () => {
  const models = await import('../../src/models');
  // 1 unmatched transfer.
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-15',
    null,
    -500,
    'CAD',
    { createdByUserId: primaryUserId, txnType: 'transfer', finalCategory: null },
  );
  // 1 matched transfer pair: when matched, BOTH sides have linkedTransactionId
  // set to the other's id (mirrors the import-pipeline contract).
  const debitId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-16',
    null,
    -300,
    'CAD',
    { createdByUserId: primaryUserId, txnType: 'transfer', finalCategory: null },
  );
  const creditId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-16',
    null,
    300,
    'CAD',
    {
      createdByUserId: primaryUserId,
      txnType: 'transfer',
      finalCategory: null,
      linkedTransactionId: debitId,
    },
  );
  await models.Transaction.update(
    { linkedTransactionId: creditId },
    { where: { id: debitId } },
  );

  const res = await primaryAgent.get('/api/data-quality');
  assert.equal(res.body.components.transfers.unmatched, 1);
});

test('GET /api/data-quality: stale subscriptions counts only status=unknown', async () => {
  await createSubscription(primaryHouseholdId, 'active', 'Active Sub');
  await createSubscription(primaryHouseholdId, 'unknown', 'Mystery Sub 1');
  await createSubscription(primaryHouseholdId, 'unknown', 'Mystery Sub 2');
  await createSubscription(primaryHouseholdId, 'cancelled', 'Done Sub');

  const res = await primaryAgent.get('/api/data-quality');
  assert.equal(res.body.components.subscriptions.stale, 2);
});

test('GET /api/data-quality: review backlog counts reviewFlag=true', async () => {
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-20',
    'Misc',
    -77,
    'CAD',
    { createdByUserId: primaryUserId, reviewFlag: true },
  );
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-21',
    'Misc',
    -33,
    'CAD',
    { createdByUserId: primaryUserId, reviewFlag: true },
  );

  const res = await primaryAgent.get('/api/data-quality');
  assert.equal(res.body.components.review.backlog, 2);
});

test('GET /api/data-quality: overall score is the unweighted mean of component scores', async () => {
  const res = await primaryAgent.get('/api/data-quality');
  const cs = res.body.componentScores;
  const expected =
    (cs.categorization +
      cs.rules +
      cs.receipts +
      cs.duplicates +
      cs.transfers +
      cs.subscriptions +
      cs.review) /
    7;
  // Round to 6 places — floating-point determinism.
  assert.equal(
    Math.round(res.body.score * 1e6) / 1e6,
    Math.round(expected * 1e6) / 1e6,
  );
});

test('GET /api/data-quality: cross-household isolation — other household never leaks in', async () => {
  // Seed a giant unreviewed mess in the OTHER household.
  for (let i = 0; i < 100; i++) {
    await createTransaction(
      otherHouseholdId,
      otherAccountId,
      '2026-05-25',
      null,
      -1000 - i,
      'CAD',
      { createdByUserId: otherUserId, reviewFlag: true, finalCategory: null },
    );
  }
  for (let i = 0; i < 20; i++) {
    await createSubscription(otherHouseholdId, 'unknown', `OtherMystery${i}`);
  }
  // The primary user's score must NOT reflect any of that.
  const primaryRes = await primaryAgent.get('/api/data-quality');
  // From earlier tests, primary household has 2 reviewFlag rows. Even after
  // seeding 100 in the other household, the primary still reports 2.
  assert.equal(primaryRes.body.components.review.backlog, 2);
  assert.equal(primaryRes.body.components.subscriptions.stale, 2);

  // The other household DOES see its own backlog.
  const otherRes = await otherAgent.get('/api/data-quality');
  assert.equal(otherRes.body.components.review.backlog, 100);
  assert.equal(otherRes.body.components.subscriptions.stale, 20);
});

test('GET /api/data-quality: score improves after resolving the review backlog (AC: score updates)', async () => {
  // Snapshot before clearing.
  const before = await primaryAgent.get('/api/data-quality');
  const beforeScore = before.body.score;
  const beforeBacklog = before.body.components.review.backlog;

  // Clear the review flag on every reviewed row.
  const models = await import('../../src/models');
  await models.Transaction.update(
    { reviewFlag: false, reviewedAt: new Date() },
    { where: { householdId: primaryHouseholdId, reviewFlag: true } },
  );

  const after = await primaryAgent.get('/api/data-quality');
  assert.equal(after.body.components.review.backlog, 0);
  assert.equal(after.body.componentScores.review, 1);
  // Backlog dropped to 0 → review component goes to 1 → overall mean rises.
  assert.ok(
    after.body.score > beforeScore,
    `expected score to rise after clearing ${beforeBacklog} reviews; ` +
      `before=${beforeScore} after=${after.body.score}`,
  );
});

test('GET /api/data-quality: actionLinks point at routable URLs for each component', async () => {
  const res = await primaryAgent.get('/api/data-quality');
  const keys = (
    res.body.actionLinks as Array<{ key: string; label: string; href: string; description: string }>
  ).map((l) => l.key);
  assert.deepEqual(keys.sort(), [
    'categorization',
    'duplicates',
    'receipts',
    'review',
    'rules',
    'subscriptions',
    'transfers',
  ]);
  for (const link of res.body.actionLinks) {
    assert.ok(link.href.startsWith('/'), `href must be relative: ${link.href}`);
    assert.ok(link.label.length > 0);
    assert.ok(link.description.length > 0);
  }
});
