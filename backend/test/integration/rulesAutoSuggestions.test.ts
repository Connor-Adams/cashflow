/**
 * Integration tests for /api/rules/auto-suggestions* (issue #211).
 * Runs against a per-file Postgres database provisioned by setupPgTestDb
 * (sets DATABASE_URL before any Sequelize import).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let householdId: number;
let accountId: number;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('rules-auto-suggestions');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // First-registered user becomes superadmin. Use that user for the
  // primary agent so household scoping resolves to a real household id
  // and visibleTransactionWhere returns rows we created.
  agent = request.agent(app);
  const register = await agent.post('/api/auth/register').send({
    email: 'rules-auto@example.com',
    displayName: 'Rules Auto',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  householdId = (register.body.user.household?.id ?? register.body.user.householdId) as number;

  const { Account } = await import('../../src/models/index.js');
  const account = await Account.create({
    householdId,
    name: 'Auto-Sugg Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  } as never);
  accountId = account.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function seedReviewedTxns(
  merchant: string,
  category: string,
  count: number,
  opts: { isBusiness?: boolean; splitType?: string } = {},
): Promise<number[]> {
  const { Transaction } = await import('../../src/models/index.js');
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    const t = await Transaction.create({
      householdId,
      accountId,
      currency: 'CAD',
      date: `2026-04-${day}`,
      merchantRaw: merchant,
      merchantClean: merchant,
      importBatch: `auto-sugg-${merchant}`,
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      amount: -10 - i,
      finalCategory: category,
      finalBusiness: opts.isBusiness ?? false,
      finalSplitType: opts.splitType ?? 'me',
      reviewedAt: new Date(),
    } as never);
    ids.push(t.id);
  }
  return ids;
}

test('GET /api/rules/auto-suggestions returns empty list when no patterns exist', async () => {
  const r = await agent.get('/api/rules/auto-suggestions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { suggestions: [] });
});

test('GET /api/rules/auto-suggestions surfaces repeated-merchant patterns with confidence + reasoning + evidence', async () => {
  await seedReviewedTxns('AUTO COFFEE', 'Dining', 5);
  const r = await agent.get('/api/rules/auto-suggestions');
  assert.equal(r.status, 200);
  const suggestions = r.body.suggestions as Array<{
    id: string;
    merchantPattern: string;
    category: string | null;
    isBusiness: boolean;
    splitType: string;
    supportCount: number;
    confidence: string;
    reasoning: string;
    evidence: Array<{ id: number; merchantClean: string; finalCategory: string | null }>;
  }>;
  const sugg = suggestions.find((s) => s.merchantPattern === 'AUTO COFFEE');
  assert.ok(sugg, 'AUTO COFFEE suggestion should be surfaced');
  assert.equal(sugg.category, 'Dining');
  assert.equal(sugg.supportCount, 5);
  assert.equal(sugg.confidence, 'high', '5 supports → high confidence');
  assert.match(sugg.reasoning, /AUTO COFFEE/);
  assert.match(sugg.reasoning, /Dining/);
  assert.match(sugg.reasoning, /5 reviewed transactions/);
  assert.ok(sugg.evidence.length > 0, 'evidence should include the matched transactions');
  assert.ok(sugg.evidence.length <= 5, 'evidence capped at 5 rows');
  for (const ev of sugg.evidence) {
    assert.equal(ev.merchantClean, 'AUTO COFFEE');
    assert.equal(ev.finalCategory, 'Dining');
  }
  assert.match(sugg.id, /^[A-Za-z0-9_-]+$/);
});

test('GET /api/rules/auto-suggestions buckets confidence by support count', async () => {
  await seedReviewedTxns('AUTO MED', 'Health', 3); // medium
  const r = await agent.get('/api/rules/auto-suggestions');
  const sugg = (r.body.suggestions as Array<{ merchantPattern: string; confidence: string }>)
    .find((s) => s.merchantPattern === 'AUTO MED');
  assert.ok(sugg);
  assert.equal(sugg.confidence, 'medium');
});

test('POST /api/rules/auto-suggestions/:id/accept creates a Rule and removes the suggestion', async () => {
  await seedReviewedTxns('AUTO PRINT', 'Office', 4, { isBusiness: true });
  const listR = await agent.get('/api/rules/auto-suggestions');
  const sugg = (listR.body.suggestions as Array<{
    id: string;
    merchantPattern: string;
    isBusiness: boolean;
  }>).find((s) => s.merchantPattern === 'AUTO PRINT');
  assert.ok(sugg, 'AUTO PRINT suggestion should be surfaced');

  const accept = await agent.post(`/api/rules/auto-suggestions/${sugg.id}/accept`);
  assert.equal(accept.status, 201);
  assert.equal(accept.body.rule.merchantPattern, 'AUTO PRINT');
  assert.equal(accept.body.rule.category, 'Office');
  assert.equal(accept.body.rule.isBusiness, true);

  // After accept, the suggestion should drop off because the merchant now
  // has a matching Rule (the existing-rules filter in findRuleProposals).
  const after = await agent.get('/api/rules/auto-suggestions');
  const stillThere = (after.body.suggestions as Array<{ merchantPattern: string }>)
    .find((s) => s.merchantPattern === 'AUTO PRINT');
  assert.equal(stillThere, undefined, 'accepted suggestion should disappear');

  // And the new Rule should be queryable via the standard list endpoint.
  const rulesR = await agent.get('/api/rules');
  const created = (rulesR.body as Array<{ merchantPattern: string; category: string | null }>)
    .find((r) => r.merchantPattern === 'AUTO PRINT');
  assert.ok(created, 'new rule should appear in GET /api/rules');
  assert.equal(created.category, 'Office');
});

test('POST /api/rules/auto-suggestions/:id/dismiss persists rejection and hides the suggestion', async () => {
  await seedReviewedTxns('AUTO DROP', 'Misc', 3);
  const listR = await agent.get('/api/rules/auto-suggestions');
  const sugg = (listR.body.suggestions as Array<{ id: string; merchantPattern: string }>)
    .find((s) => s.merchantPattern === 'AUTO DROP');
  assert.ok(sugg);

  const dismiss = await agent.post(`/api/rules/auto-suggestions/${sugg.id}/dismiss`);
  assert.equal(dismiss.status, 201);
  assert.equal(dismiss.body.ok, true);
  assert.ok(typeof dismiss.body.dismissalId === 'number');

  // Verify the persisted ai_suggestions row matches the shape that the
  // existing /api/ai/rule-proposals/:pattern/dismiss endpoint writes, so
  // both surfaces stay interoperable.
  const { AiSuggestion } = await import('../../src/models/index.js');
  const stored = await AiSuggestion.findOne({
    where: { id: dismiss.body.dismissalId },
  });
  assert.ok(stored);
  assert.equal(stored.kind, 'rule_proposal');
  assert.equal(stored.status, 'rejected');
  assert.deepEqual(stored.inputSnapshot, { merchantPattern: 'AUTO DROP' });

  // The suggestion should now be filtered out.
  const after = await agent.get('/api/rules/auto-suggestions');
  const stillThere = (after.body.suggestions as Array<{ merchantPattern: string }>)
    .find((s) => s.merchantPattern === 'AUTO DROP');
  assert.equal(stillThere, undefined, 'dismissed suggestion should not reappear');
});

test('POST /api/rules/auto-suggestions/:id/accept 404s for unknown id', async () => {
  const r = await agent.post('/api/rules/auto-suggestions/notarealid/accept');
  assert.equal(r.status, 404);
  assert.match(String(r.body.error), /not found/i);
});

test('POST /api/rules/auto-suggestions/:id/dismiss 404s for unknown id', async () => {
  const r = await agent.post('/api/rules/auto-suggestions/notarealid/dismiss');
  assert.equal(r.status, 404);
  assert.match(String(r.body.error), /not found/i);
});

test('GET /api/rules/auto-suggestions excludes merchants that already have a rule', async () => {
  await seedReviewedTxns('AUTO EXIST', 'Books', 4);
  // Manually create a rule first
  const create = await agent.post('/api/rules').send({
    merchantPattern: 'AUTO EXIST',
    category: 'Books',
  });
  assert.equal(create.status, 201);

  const r = await agent.get('/api/rules/auto-suggestions');
  const sugg = (r.body.suggestions as Array<{ merchantPattern: string }>)
    .find((s) => s.merchantPattern === 'AUTO EXIST');
  assert.equal(sugg, undefined, 'merchants with an existing rule should not be suggested');
});

test('GET /api/rules/auto-suggestions IDs are stable across calls', async () => {
  await seedReviewedTxns('AUTO STABLE', 'Music', 3);
  const r1 = await agent.get('/api/rules/auto-suggestions');
  const r2 = await agent.get('/api/rules/auto-suggestions');
  const s1 = (r1.body.suggestions as Array<{ id: string; merchantPattern: string }>)
    .find((s) => s.merchantPattern === 'AUTO STABLE');
  const s2 = (r2.body.suggestions as Array<{ id: string; merchantPattern: string }>)
    .find((s) => s.merchantPattern === 'AUTO STABLE');
  assert.ok(s1 && s2);
  assert.equal(s1.id, s2.id);
});
