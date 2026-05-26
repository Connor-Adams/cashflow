/**
 * Integration tests for /api/rules/auto-suggestions (issue #211).
 *
 * Behavioral-pattern detection: when a user has repeatedly manually
 * categorized transactions for a merchant (reviewed_at IS NOT NULL and a
 * consistent final_category), the API surfaces a high-confidence
 * suggestion to turn that pattern into a real Rule. Accept creates the
 * rule; dismiss persists a rejection so it doesn't resurface.
 *
 * Runs in isolation (`yarn test:integration`) against a per-file Postgres
 * database provisioned by setupPgTestDb. Test patterned after
 * rulesEffectiveDates.test.ts + aiInbox.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let householdId: number;
let otherHouseholdId: number;
let accountId: number;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('rules-auto-suggestions');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // First-registered user becomes superadmin. We need a regular household
  // session to exercise household scoping, not the superadmin agent.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `autosug-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: 'Suggestions Owner',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Suggestions household' });
  householdId = household.id;
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);

  // Account on this household so transactions can FK-link.
  const account = await models.Account.create({
    householdId,
    name: 'Auto-suggestion Acct',
    owner: 'me',
    defaultCurrency: 'CAD',
  } as never);
  accountId = account.id;

  // Second household + agent for scoping tests.
  const otherPassword = await hashPassword('password123');
  const otherUser = await models.User.create({
    email: `autosug-other-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: 'Other Owner',
    globalRole: 'user',
    passwordHash: otherPassword.hash,
    passwordSalt: otherPassword.salt,
    passwordParams: otherPassword.params,
  });
  const otherHousehold = await models.Household.create({ name: 'Other household' });
  otherHouseholdId = otherHousehold.id;
  await models.HouseholdMember.create({
    householdId: otherHousehold.id,
    userId: otherUser.id,
    role: 'owner',
  });
  const otherToken = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: otherUser.id,
    tokenHash: hashToken(otherToken),
    expiresAt,
  });
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${otherToken}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function seedReviewedTransactions(params: {
  merchantClean: string;
  category: string;
  count: number;
  householdIdOverride?: number;
  accountIdOverride?: number;
  isBusiness?: boolean;
  splitType?: string;
  batch?: string;
}): Promise<number[]> {
  const { Transaction } = await import('../../src/models/index.js');
  const ids: number[] = [];
  const hh = params.householdIdOverride ?? householdId;
  const acct = params.accountIdOverride ?? accountId;
  for (let i = 0; i < params.count; i += 1) {
    const row = await Transaction.create({
      householdId: hh,
      accountId: acct,
      currency: 'CAD',
      date: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
      merchantRaw: params.merchantClean,
      merchantClean: params.merchantClean,
      importBatch: params.batch ?? `auto-sug-${params.merchantClean}`,
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      amount: -10 - i,
      finalCategory: params.category,
      finalBusiness: params.isBusiness ?? false,
      finalSplitType: params.splitType ?? 'me',
      reviewedAt: new Date(),
    } as never);
    ids.push(row.id);
  }
  return ids;
}

test('GET /api/rules/auto-suggestions surfaces a high-confidence merchant pattern', async () => {
  await seedReviewedTransactions({
    merchantClean: 'STARBUCKS DOWNTOWN',
    category: 'Coffee',
    count: 4,
  });

  const res = await agent.get('/api/rules/auto-suggestions');
  assert.equal(res.status, 200);
  const suggestions = res.body.suggestions as Array<Record<string, unknown>>;
  const target = suggestions.find((s) => s.merchantPattern === 'STARBUCKS DOWNTOWN');
  assert.ok(target, 'expected STARBUCKS DOWNTOWN in suggestions');
  assert.equal(target.category, 'Coffee');
  assert.equal(target.supportCount, 4);
  assert.equal(target.confidence, 1);
  assert.equal(typeof target.id, 'string');
  assert.ok(String(target.id).length > 0, 'id should be a non-empty stable string');
  assert.match(String(target.reasoning), /4 of 4/);
});

test('GET /api/rules/auto-suggestions includes evidence transaction ids', async () => {
  const res = await agent.get('/api/rules/auto-suggestions');
  const target = (res.body.suggestions as Array<{ merchantPattern: string; exampleTransactionIds: number[] }>)
    .find((s) => s.merchantPattern === 'STARBUCKS DOWNTOWN');
  assert.ok(target);
  assert.ok(Array.isArray(target.exampleTransactionIds));
  assert.ok(target.exampleTransactionIds.length > 0, 'should include example transaction IDs');
});

test('GET /api/rules/auto-suggestions filters out low-confidence patterns (<0.8)', async () => {
  // 3 to "Snacks" + 3 to "Groceries" = 0.5 confidence on each → must be hidden.
  await seedReviewedTransactions({
    merchantClean: 'MIXED MART',
    category: 'Snacks',
    count: 3,
    batch: 'mixed-mart-snacks',
  });
  await seedReviewedTransactions({
    merchantClean: 'MIXED MART',
    category: 'Groceries',
    count: 3,
    batch: 'mixed-mart-groceries',
  });

  const res = await agent.get('/api/rules/auto-suggestions');
  const offenders = (res.body.suggestions as Array<{ merchantPattern: string }>)
    .filter((s) => s.merchantPattern === 'MIXED MART');
  assert.equal(offenders.length, 0, '50/50 split should be filtered out');
});

test('GET /api/rules/auto-suggestions keeps borderline confidence at 0.8 (4 of 5)', async () => {
  // 4 to "Subscriptions" + 1 to "Misc" = 4/5 = 0.8 confidence → keep majority.
  await seedReviewedTransactions({
    merchantClean: 'NEWSPAPER CO',
    category: 'Subscriptions',
    count: 4,
    batch: 'newspaper-sub',
  });
  await seedReviewedTransactions({
    merchantClean: 'NEWSPAPER CO',
    category: 'Misc',
    count: 1,
    batch: 'newspaper-misc',
  });

  const res = await agent.get('/api/rules/auto-suggestions');
  const majority = (res.body.suggestions as Array<{ merchantPattern: string; category: string; confidence: number }>)
    .find((s) => s.merchantPattern === 'NEWSPAPER CO' && s.category === 'Subscriptions');
  assert.ok(majority, 'majority Subscriptions should appear at 0.8 confidence');
  assert.ok(majority.confidence >= 0.8);

  const minority = (res.body.suggestions as Array<{ merchantPattern: string; category: string }>)
    .find((s) => s.merchantPattern === 'NEWSPAPER CO' && s.category === 'Misc');
  assert.equal(minority, undefined, 'minority Misc (0.2) must be filtered out');
});

test('GET /api/rules/auto-suggestions hides patterns that already have a matching rule', async () => {
  await seedReviewedTransactions({
    merchantClean: 'ALREADY RULED',
    category: 'Groceries',
    count: 3,
    batch: 'already-ruled',
  });
  // Create a real rule for that exact pattern.
  const create = await agent.post('/api/rules').send({
    merchantPattern: 'ALREADY RULED',
    category: 'Groceries',
  });
  assert.equal(create.status, 201);

  const res = await agent.get('/api/rules/auto-suggestions');
  const offenders = (res.body.suggestions as Array<{ merchantPattern: string }>)
    .filter((s) => s.merchantPattern === 'ALREADY RULED');
  assert.equal(offenders.length, 0);
});

test('POST /api/rules/auto-suggestions/:id/accept creates a real Rule', async () => {
  await seedReviewedTransactions({
    merchantClean: 'ACCEPT ME',
    category: 'Utilities',
    count: 3,
    batch: 'accept-me',
  });

  const listed = await agent.get('/api/rules/auto-suggestions');
  const target = (listed.body.suggestions as Array<{ id: string; merchantPattern: string }>)
    .find((s) => s.merchantPattern === 'ACCEPT ME');
  assert.ok(target, 'precondition: ACCEPT ME should be suggested');

  const accept = await agent.post(`/api/rules/auto-suggestions/${target.id}/accept`);
  assert.equal(accept.status, 201);
  assert.equal(accept.body.merchantPattern, 'ACCEPT ME');
  assert.equal(accept.body.category, 'Utilities');

  // Suggestion should disappear (now backed by a real rule).
  const after = await agent.get('/api/rules/auto-suggestions');
  const stillThere = (after.body.suggestions as Array<{ merchantPattern: string }>)
    .filter((s) => s.merchantPattern === 'ACCEPT ME');
  assert.equal(stillThere.length, 0, 'accepted suggestion should no longer appear');

  // Real Rule visible via /api/rules.
  const rules = await agent.get('/api/rules');
  const created = (rules.body as Array<{ merchantPattern: string; category: string }>)
    .find((r) => r.merchantPattern === 'ACCEPT ME');
  assert.ok(created);
  assert.equal(created.category, 'Utilities');
});

test('POST /api/rules/auto-suggestions/:id/dismiss persists rejection so it no longer surfaces', async () => {
  await seedReviewedTransactions({
    merchantClean: 'DISMISS ME',
    category: 'Junk',
    count: 3,
    batch: 'dismiss-me',
  });

  const before = await agent.get('/api/rules/auto-suggestions');
  const target = (before.body.suggestions as Array<{ id: string; merchantPattern: string }>)
    .find((s) => s.merchantPattern === 'DISMISS ME');
  assert.ok(target);

  const dismiss = await agent.post(`/api/rules/auto-suggestions/${target.id}/dismiss`);
  assert.equal(dismiss.status, 201);
  assert.equal(dismiss.body.ok, true);

  const after = await agent.get('/api/rules/auto-suggestions');
  const stillThere = (after.body.suggestions as Array<{ merchantPattern: string }>)
    .filter((s) => s.merchantPattern === 'DISMISS ME');
  assert.equal(stillThere.length, 0, 'dismissed suggestion should not return');

  // Persistence: ai_suggestions row with kind=rule_proposal, status=rejected.
  const { AiSuggestion } = await import('../../src/models/index.js');
  const stored = await AiSuggestion.findOne({
    where: { householdId, kind: 'rule_proposal', status: 'rejected' },
    order: [['id', 'DESC']],
  });
  assert.ok(stored);
  const snapshot = stored.inputSnapshot as { merchantPattern?: string };
  assert.equal(snapshot.merchantPattern, 'DISMISS ME');
});

test('POST /api/rules/auto-suggestions/:id/accept returns 404 for an unknown id', async () => {
  const res = await agent.post('/api/rules/auto-suggestions/nonexistentidxxxx/accept');
  assert.equal(res.status, 404);
});

test('POST /api/rules/auto-suggestions/:id/dismiss returns 404 for an unknown id', async () => {
  const res = await agent.post('/api/rules/auto-suggestions/nonexistentidxxxx/dismiss');
  assert.equal(res.status, 404);
});

test('GET /api/rules/auto-suggestions scopes by household', async () => {
  // Seed a high-confidence pattern in the OTHER household.
  const { Account } = await import('../../src/models/index.js');
  const otherAccount = await Account.create({
    householdId: otherHouseholdId,
    name: 'Other Acct',
    owner: 'me',
    defaultCurrency: 'CAD',
  } as never);
  await seedReviewedTransactions({
    merchantClean: 'OTHER ONLY',
    category: 'Utilities',
    count: 3,
    householdIdOverride: otherHouseholdId,
    accountIdOverride: otherAccount.id,
    batch: 'other-only',
  });

  const mine = await agent.get('/api/rules/auto-suggestions');
  const leaked = (mine.body.suggestions as Array<{ merchantPattern: string }>)
    .filter((s) => s.merchantPattern === 'OTHER ONLY');
  assert.equal(leaked.length, 0, 'other household pattern must not appear');

  const theirs = await otherAgent.get('/api/rules/auto-suggestions');
  const visible = (theirs.body.suggestions as Array<{ merchantPattern: string }>)
    .filter((s) => s.merchantPattern === 'OTHER ONLY');
  assert.ok(visible.length >= 1, 'pattern must appear for its own household');
});
