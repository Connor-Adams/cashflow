/**
 * Integration tests for POST /api/chat/proposals/:id/apply and /reject
 * (PR2 Task 12 — HTTP layer).
 *
 * `chatProposalsApply.test.ts` already exercises `applyProposal()` as a direct
 * function call. This file drives the HTTP endpoints end-to-end via supertest
 * so we catch routing, auth scoping, and status-code mapping (200 / 404 / 409)
 * that the unit-level tests don't see.
 *
 * Proposals are constructed by importing the build helpers directly and
 * calling them with a hand-rolled ProposalContext rather than by going through
 * the SSE message endpoint — that keeps the test focused on the apply/reject
 * surface and avoids stubbing OpenAI.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let models: typeof import('../../src/models/index.js');
let proposalsMod: typeof import('../../src/ai/chat/proposals.js');
let testDb: PgTestDb;

interface UserAgentBundle {
  agent: ReturnType<typeof request.agent>;
  userId: number;
  householdId: number;
  accountId: number;
}

let user1: UserAgentBundle;
let user2: UserAgentBundle;

before(async () => {
  testDb = await setupPgTestDb('chat-proposals-apply-reject');

  const appMod = await import('../../src/app.js');
  app = appMod.default;

  // First-registered user becomes superadmin; we don't use that agent.
  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  models = await import('../../src/models');
  proposalsMod = await import('../../src/ai/chat/proposals.js');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');

  // Helper: build a fully-wired (User + Household + Account + Session +
  // cookie agent) bundle. Each user gets its own household so cross-user
  // scope tests are meaningful.
  async function makeBundle(label: string): Promise<UserAgentBundle> {
    const pw = await hashPassword('password123');
    const user = await models.User.create({
      email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      displayName: label,
      globalRole: 'user',
      passwordHash: pw.hash,
      passwordSalt: pw.salt,
      passwordParams: pw.params,
    });
    const household = await models.Household.create({ name: `${label} house` });
    await models.HouseholdMember.create({
      householdId: household.id,
      userId: user.id,
      role: 'owner',
    });
    const account = await models.Account.create({
      name: `${label} checking`,
      owner: 'me',
      householdId: household.id,
    } as never);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
    await models.Session.create({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
    });
    const a = testAgent(app);
    a.jar.setCookie(`cashflow_session=${token}; Path=/`);
    return {
      agent: a,
      userId: user.id,
      householdId: household.id,
      accountId: account.id,
    };
  }

  user1 = await makeBundle('Apply User 1');
  user2 = await makeBundle('Apply User 2');
});

after(async () => {
  delete process.env.CHAT_PROPOSAL_DRIFT_PCT;
  await teardownPgTestDb(testDb);
});

beforeEach(() => {
  delete process.env.CHAT_PROPOSAL_DRIFT_PCT;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function newThread(
  bundle: UserAgentBundle,
  title?: string
): Promise<{ threadId: number; messageId: number }> {
  const res = await bundle.agent.post('/api/chat/threads').send({ title });
  assert.equal(res.status, 201);
  const threadId = res.body.id as number;
  // Seed a user message so the proposal has a messageId to reference.
  const message = await models.ChatMessage.create({
    threadId,
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
  return { threadId, messageId: message.id };
}

/**
 * Seed a transaction whose merchantClean contains `merchantTag`. Each test
 * uses a unique tag so its bulk_patch filter only matches its own rows (the
 * test DB is shared across tests in this file and never wiped, so we don't
 * accidentally inflate the matched count from sibling tests).
 */
async function seedMatchingTxn(
  bundle: UserAgentBundle,
  merchantTag: string,
  fp: string,
  overrides: Record<string, unknown> = {}
): Promise<number> {
  const row = await models.Transaction.create({
    accountId: bundle.accountId,
    householdId: bundle.householdId,
    visibility: 'shared',
    importBatch: 'seed',
    date: '2026-05-10',
    merchantRaw: `MERCHANT ${merchantTag}`,
    merchantClean: `MERCHANT ${merchantTag}`,
    amount: '20.00',
    currency: 'CAD',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: `sid-${Math.random()}`,
    finalCategory: 'Uncategorized',
    finalSplitType: 'shared',
    finalBusiness: false,
    myShareAmount: '10.00',
    partnerShareAmount: '10.00',
    businessAmount: '0',
    reviewFlag: false,
    ...overrides,
  } as never);
  return row.id;
}

async function buildBulkPatchFor(
  bundle: UserAgentBundle,
  ctx: { threadId: number; messageId: number },
  merchantTag: string
): Promise<number> {
  const built = await proposalsMod.buildBulkPatchPreview(
    { merchant_pattern: merchantTag },
    { category_override: 'Groceries' },
    {
      userId: bundle.userId,
      householdId: bundle.householdId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
    }
  );
  assert.ok('proposal_id' in built, 'buildBulkPatchPreview must succeed');
  if (!('proposal_id' in built)) throw new Error('unreachable');
  return built.proposal_id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('POST /proposals/:id/apply on pending bulk_patch returns 200, mutates txns, marks applied, appends role=tool', async () => {
  const tag = 'APOKMART';
  const ctx = await newThread(user1, 'apply ok');
  const t1 = await seedMatchingTxn(user1, tag, `apok-1-${Math.random()}`);
  const t2 = await seedMatchingTxn(user1, tag, `apok-2-${Math.random()}`);
  const proposalId = await buildBulkPatchFor(user1, ctx, tag);

  const res = await user1.agent
    .post(`/api/chat/proposals/${proposalId}/apply`)
    .send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'applied');
  const result = res.body.result as { updated_count: number; ids: number[] };
  assert.equal(result.updated_count, 2);
  assert.deepEqual(
    [...result.ids].sort((a, b) => a - b),
    [t1, t2].sort((a, b) => a - b)
  );

  // Both transactions were mutated in the DB.
  const after = await models.Transaction.findAll({ where: { id: [t1, t2] } });
  assert.equal(after.length, 2);
  for (const row of after) {
    assert.equal(row.categoryOverride, 'Groceries');
  }

  // Proposal status flipped to 'applied' + appliedAt set.
  const proposal = await models.ChatProposal.findByPk(proposalId);
  assert.ok(proposal);
  assert.equal(proposal!.status, 'applied');
  assert.ok(proposal!.appliedAt instanceof Date);

  // role=tool message appended for this proposal.
  const toolMsgs = await models.ChatMessage.findAll({
    where: {
      threadId: ctx.threadId,
      role: 'tool',
      toolCallId: `proposal_${proposalId}`,
    },
  });
  assert.equal(toolMsgs.length, 1);
  assert.equal(toolMsgs[0].toolName, 'apply_bulk_patch');
  const payload = JSON.parse(toolMsgs[0].contentText ?? '');
  assert.equal(payload.applied, 'bulk_patch');
});

test('POST /proposals/:id/apply twice → second returns 409 not_pending', async () => {
  const tag = 'APTWMART';
  const ctx = await newThread(user1, 'apply twice');
  await seedMatchingTxn(user1, tag, `aptw-1-${Math.random()}`);
  await seedMatchingTxn(user1, tag, `aptw-2-${Math.random()}`);
  const proposalId = await buildBulkPatchFor(user1, ctx, tag);

  const first = await user1.agent
    .post(`/api/chat/proposals/${proposalId}/apply`)
    .send({});
  assert.equal(first.status, 200);

  const second = await user1.agent
    .post(`/api/chat/proposals/${proposalId}/apply`)
    .send({});
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'not_pending');
});

test('POST /proposals/:id/apply on expired proposal → 409 expired', async () => {
  const tag = 'APEXMART';
  const ctx = await newThread(user1, 'apply expired');
  await seedMatchingTxn(user1, tag, `apex-1-${Math.random()}`);
  await seedMatchingTxn(user1, tag, `apex-2-${Math.random()}`);
  const proposalId = await buildBulkPatchFor(user1, ctx, tag);

  // Force expiry on the proposal row directly.
  await models.ChatProposal.update(
    { expiresAt: new Date(0) },
    { where: { id: proposalId } }
  );

  const res = await user1.agent
    .post(`/api/chat/proposals/${proposalId}/apply`)
    .send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'expired');

  // Proposal row should now be marked expired.
  const proposal = await models.ChatProposal.findByPk(proposalId);
  assert.equal(proposal!.status, 'expired');
});

test('POST /proposals/:id/apply with count drift past threshold → 409 count_drifted + preview/current counts', async () => {
  // Tight threshold so 2 → 6 (200% drift) trips the guard.
  process.env.CHAT_PROPOSAL_DRIFT_PCT = '0.1';
  const tag = 'APDRMART';
  const ctx = await newThread(user1, 'apply drift');
  await seedMatchingTxn(user1, tag, `apdr-1-${Math.random()}`);
  await seedMatchingTxn(user1, tag, `apdr-2-${Math.random()}`);
  const proposalId = await buildBulkPatchFor(user1, ctx, tag);

  // Insert 4 more matching txns between preview and apply.
  for (let i = 0; i < 4; i++) {
    await seedMatchingTxn(user1, tag, `apdr-late-${i}-${Math.random()}`, {
      date: `2026-06-${10 + i}`,
    });
  }

  const res = await user1.agent
    .post(`/api/chat/proposals/${proposalId}/apply`)
    .send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'count_drifted');
  assert.equal(res.body.preview_count, 2);
  assert.equal(res.body.current_count, 6);

  // Proposal still pending (drift is a soft halt, not a state transition).
  const proposal = await models.ChatProposal.findByPk(proposalId);
  assert.equal(proposal!.status, 'pending');
});

test('POST /proposals/:id/reject on pending → 200 rejected, role=tool appended, subsequent apply → 409 not_pending', async () => {
  const tag = 'RJAMART';
  const ctx = await newThread(user1, 'reject then apply');
  await seedMatchingTxn(user1, tag, `rja-1-${Math.random()}`);
  await seedMatchingTxn(user1, tag, `rja-2-${Math.random()}`);
  const proposalId = await buildBulkPatchFor(user1, ctx, tag);

  const rejected = await user1.agent
    .post(`/api/chat/proposals/${proposalId}/reject`)
    .send({});
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'rejected');

  // Proposal row reflects the rejection.
  const proposal = await models.ChatProposal.findByPk(proposalId);
  assert.equal(proposal!.status, 'rejected');

  // role=tool reject message appended.
  const toolMsgs = await models.ChatMessage.findAll({
    where: {
      threadId: ctx.threadId,
      role: 'tool',
      toolCallId: `proposal_${proposalId}`,
    },
  });
  assert.equal(toolMsgs.length, 1);
  assert.equal(toolMsgs[0].toolName, 'reject_bulk_patch');
  const payload = JSON.parse(toolMsgs[0].contentText ?? '');
  assert.equal(payload.rejected, 'bulk_patch');

  // Now an apply attempt is blocked.
  const applyAttempt = await user1.agent
    .post(`/api/chat/proposals/${proposalId}/apply`)
    .send({});
  assert.equal(applyAttempt.status, 409);
  assert.equal(applyAttempt.body.error, 'not_pending');
});

test("POST /proposals/:id/apply on another user's proposal → 404", async () => {
  // user2 owns the thread + proposal.
  const tag = 'XUMART';
  const ctx2 = await newThread(user2, 'cross-user target');
  await seedMatchingTxn(user2, tag, `xu-1-${Math.random()}`);
  await seedMatchingTxn(user2, tag, `xu-2-${Math.random()}`);
  const proposalId = await buildBulkPatchFor(user2, ctx2, tag);

  // user1 (different household, different threads) attempts to apply.
  const res = await user1.agent
    .post(`/api/chat/proposals/${proposalId}/apply`)
    .send({});
  assert.equal(res.status, 404);

  // Proposal must still be pending (cross-user attempt cannot mutate state).
  const proposal = await models.ChatProposal.findByPk(proposalId);
  assert.equal(proposal!.status, 'pending');
});
