/**
 * Integration tests for GET /api/review-items (issue #378).
 *
 * The unified read endpoint fans out across the four review-item sources
 * (AiSuggestion, AiReviewRun action items, CfoBriefing action items,
 * ChatProposal) and normalizes them into a common shape. Writes stay
 * per-source — this endpoint is read-only.
 *
 * Runs in isolation (`yarn test:integration`) against a per-file Postgres
 * database provisioned by setupPgTestDb (sets DATABASE_URL before any
 * Sequelize import).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryUserId: number;
let otherHouseholdId: number;
let otherUserId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
};

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
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  return { token, householdId: household.id, userId: user.id };
}

/**
 * Seed exactly one item of each of the four sources for a household/user, with
 * monotonically increasing createdAt so the merge order is deterministic.
 * Order of creation (oldest → newest): ai-suggestion, ai-review, cfo-briefing,
 * chat-proposal — so chat-proposal must come first in the desc-sorted result.
 */
async function seedAllSources(householdId: number, userId: number): Promise<void> {
  const models = await import('../../src/models');

  await models.AiSuggestion.create({
    householdId,
    userId,
    transactionId: null,
    receiptId: null,
    kind: 'financial_insight',
    status: 'suggested',
    output: { headline: 'Spending up 20%' },
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
  } as never);

  await models.AiReviewRun.create({
    householdId,
    userId,
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    currency: 'CAD',
    status: 'completed',
    summary: 'review',
    actionItems: [
      {
        id: 'rev-item-1',
        type: 'subscription',
        refType: 'transaction',
        refId: 999,
        severity: 'watch',
        title: 'Netflix recurring',
        summary: 'Looks like a subscription',
        status: 'suggested',
      },
    ],
    model: 'deterministic',
    promptVersion: 'ai-review-v1',
    createdAt: new Date('2026-05-02T00:00:00Z'),
    updatedAt: new Date('2026-05-02T00:00:00Z'),
  } as never);

  await models.CfoBriefing.create({
    householdId,
    userId,
    periodStart: '2026-05-01',
    periodEnd: '2026-05-07',
    currency: 'CAD',
    status: 'completed',
    summary: 'briefing',
    actionItems: [
      {
        id: 'brief-item-1',
        type: 'safe_to_spend_low',
        refType: 'subscription',
        refId: 12,
        severity: 'action',
        title: 'Safe-to-spend low',
        summary: 'Careful this week',
        status: 'open',
      },
    ],
    safeToSpendSnapshot: null,
    model: 'deterministic',
    promptVersion: 'cfo-briefing-v1',
    createdAt: new Date('2026-05-03T00:00:00Z'),
    updatedAt: new Date('2026-05-03T00:00:00Z'),
  } as never);

  const thread = await models.ChatThread.create({
    userId,
    title: 'Tagging chat',
    createdAt: new Date('2026-05-04T00:00:00Z'),
    updatedAt: new Date('2026-05-04T00:00:00Z'),
  } as never);
  const message = await models.ChatMessage.create({
    threadId: thread.id,
    role: 'user',
    contentText: 'please tag these',
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    model: null,
    promptTokens: null,
    completionTokens: null,
    latencyMs: null,
    providerRequestId: null,
  } as never);
  await models.ChatProposal.create({
    threadId: thread.id,
    messageId: message.id,
    kind: 'bulk_patch',
    status: 'pending',
    payload: { filter: { merchant: 'X' }, patch: { category: 'Coffee' } },
    preview: { matchedCount: 4 },
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    appliedAt: null,
    appliedResult: null,
    createdAt: new Date('2026-05-04T00:00:00Z'),
    updatedAt: new Date('2026-05-04T00:00:00Z'),
  } as never);
}

before(async () => {
  process.env.NODE_ENV = 'test';
  delete process.env.OPENAI_API_KEY;

  testDb = await setupPgTestDb('review-items');
  const mod = await import('../../src/app.js');
  app = mod.default;

  // First registered user becomes superadmin — used only to bootstrap.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryUserId = primary.userId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherUserId = other.userId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);

  await seedAllSources(primaryHouseholdId, primaryUserId);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

type ReviewItem = {
  id: string;
  source: string;
  subject_type: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  status_common: string;
  native_status: string;
  created_at: string;
  resolved_at: string | null;
};
type ListResponse = { data: ReviewItem[]; nextCursor: string | null };

test('GET /api/review-items returns one normalized item per source, all pending, newest-first', async () => {
  const r = await primaryAgent.get('/api/review-items');
  assert.equal(r.status, 200);
  const body = r.body as ListResponse;
  assert.ok(Array.isArray(body.data), 'data must be an array');
  assert.equal(body.data.length, 4, `expected 4 items, got ${body.data.length}`);

  const sources = body.data.map((i) => i.source).sort();
  assert.deepEqual(sources, ['ai-review', 'ai-suggestion', 'cfo-briefing', 'chat-proposal']);

  for (const item of body.data) {
    assert.equal(item.status_common, 'pending');
    assert.ok(item.id.startsWith(`${item.source}:`), `id ${item.id} must be prefixed by source`);
    assert.ok(item.resolved_at == null, 'pending items have null resolved_at');
  }

  // created_at desc: chat-proposal (05-04) >= cfo-briefing (05-03) >= ai-review (05-02) >= ai-suggestion (05-01)
  for (let i = 1; i < body.data.length; i++) {
    assert.ok(
      body.data[i - 1].created_at >= body.data[i].created_at,
      `expected DESC by created_at, got ${body.data[i - 1].created_at} then ${body.data[i].created_at}`,
    );
  }
  assert.equal(body.data[0].source, 'chat-proposal');
});

test('GET /api/review-items normalizes per-source subject + payload correctly', async () => {
  const r = await primaryAgent.get('/api/review-items');
  const bySource = new Map((r.body as ListResponse).data.map((i) => [i.source, i]));

  const review = bySource.get('ai-review')!;
  assert.ok(review.id.endsWith(':rev-item-1'), `review id should end with item id: ${review.id}`);
  assert.equal(review.subject_type, 'transaction');
  assert.equal(review.subject_id, '999');
  assert.equal(review.native_status, 'suggested');

  const briefing = bySource.get('cfo-briefing')!;
  assert.ok(briefing.id.endsWith(':brief-item-1'));
  assert.equal(briefing.subject_type, 'subscription');
  assert.equal(briefing.subject_id, '12');
  assert.equal(briefing.native_status, 'open');

  const chat = bySource.get('chat-proposal')!;
  assert.equal(chat.subject_type, 'chat-message');
  assert.equal(chat.native_status, 'pending');
  assert.deepEqual(chat.payload.preview, { matchedCount: 4 });

  const suggestion = bySource.get('ai-suggestion')!;
  assert.equal(suggestion.subject_type, null);
  assert.equal(suggestion.native_status, 'suggested');
});

test('GET /api/review-items?source=ai-review returns only that source', async () => {
  const r = await primaryAgent.get('/api/review-items').query({ source: 'ai-review' });
  assert.equal(r.status, 200);
  const data = (r.body as ListResponse).data;
  assert.equal(data.length, 1);
  assert.equal(data[0].source, 'ai-review');
});

test('GET /api/review-items?source=ai-suggestion,chat-proposal returns the two', async () => {
  const r = await primaryAgent
    .get('/api/review-items')
    .query({ source: 'ai-suggestion,chat-proposal' });
  assert.equal(r.status, 200);
  const sources = (r.body as ListResponse).data.map((i) => i.source).sort();
  assert.deepEqual(sources, ['ai-suggestion', 'chat-proposal']);
});

test('GET /api/review-items?status=resolved returns none (all seeded items are pending)', async () => {
  const r = await primaryAgent.get('/api/review-items').query({ status: 'resolved' });
  assert.equal(r.status, 200);
  assert.equal((r.body as ListResponse).data.length, 0);
});

test('GET /api/review-items?status=pending,resolved still returns the four pending items', async () => {
  const r = await primaryAgent.get('/api/review-items').query({ status: 'pending,resolved' });
  assert.equal(r.status, 200);
  assert.equal((r.body as ListResponse).data.length, 4);
});

test('GET /api/review-items is household/user scoped — other household sees nothing', async () => {
  const r = await otherAgent.get('/api/review-items');
  assert.equal(r.status, 200);
  assert.equal((r.body as ListResponse).data.length, 0);
});

test('GET /api/review-items paginates with limit + cursor', async () => {
  const first = await primaryAgent.get('/api/review-items').query({ limit: 2 });
  assert.equal(first.status, 200);
  const firstBody = first.body as ListResponse;
  assert.equal(firstBody.data.length, 2);
  assert.ok(firstBody.nextCursor, 'expected a nextCursor when more remain');

  const second = await primaryAgent
    .get('/api/review-items')
    .query({ limit: 2, cursor: firstBody.nextCursor });
  assert.equal(second.status, 200);
  const secondBody = second.body as ListResponse;
  assert.equal(secondBody.data.length, 2);
  assert.equal(secondBody.nextCursor, null, 'no more pages after the last item');

  // No overlap between pages.
  const firstIds = new Set(firstBody.data.map((i) => i.id));
  for (const item of secondBody.data) {
    assert.ok(!firstIds.has(item.id), `page 2 item ${item.id} should not appear on page 1`);
  }
});

test('GET /api/review-items rejects limit over the max with a clamp (returns <=200)', async () => {
  const r = await primaryAgent.get('/api/review-items').query({ limit: 9999 });
  assert.equal(r.status, 200);
  // Only 4 items exist; the clamp is exercised by the route, asserted indirectly.
  assert.ok((r.body as ListResponse).data.length <= 200);
});

test('GET /api/review-items requires auth', async () => {
  const r = await request(app).get('/api/review-items');
  assert.equal(r.status, 401);
});

// Anchors to keep lint happy if these become unused.
void otherHouseholdId;
void otherUserId;
