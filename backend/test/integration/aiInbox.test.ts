/**
 * Integration tests for /api/ai/inbox*. Runs in isolation
 * (`yarn test:integration`) against a per-file Postgres database provisioned
 * by setupPgTestDb (sets DATABASE_URL before any Sequelize import).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let regularAgent: ReturnType<typeof request.agent>;
let householdId: number;
let otherHouseholdId: number;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('ai-inbox');

  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = testAgent(app);
  // First registered user becomes superadmin.
  const register = await authed.post('/api/auth/register').send({
    email: 'inbox@example.com',
    displayName: 'Inbox User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  householdId = (register.body.user.household?.id ?? register.body.user.householdId) as number;

  // Create a second household + non-superadmin user via model layer so we can test
  // household scoping independently of the superadmin user.
  const { Household, User: UserModel, HouseholdMember, Session: SessionModel } = await import('../../src/models/index.js');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const pwd = await hashPassword('password123');
  const otherUser = await UserModel.create({
    email: 'inbox-other@example.com',
    displayName: 'Other User',
    globalRole: 'user',
    passwordHash: pwd.hash,
    passwordSalt: pwd.salt,
    passwordParams: pwd.params,
  });
  const otherHousehold = await Household.create({ name: 'Other Household' });
  otherHouseholdId = otherHousehold.id;
  await HouseholdMember.create({ householdId: otherHouseholdId, userId: otherUser.id, role: 'owner' });
  const crypto = await import('crypto');
  const rawToken = crypto.randomBytes(32).toString('hex');
  await SessionModel.create({
    userId: otherUser.id,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + 86400 * 1000),
  });
  regularAgent = testAgent(app);
  regularAgent.jar.setCookie(`cashflow_session=${rawToken}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/ai/inbox/count returns zeros when nothing pending', async () => {
  const r = await authed.get('/api/ai/inbox/count');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    total: 0,
    byKind: {
      transaction_audit: 0,
      financial_insight: 0,
      rule_proposal: 0,
      counterparty_promotion: 0,
    },
  });
});

test('GET /api/ai/inbox/count counts audit rows but never open insights', async () => {
  const { AiSuggestion, Insight } = await import('../../src/models/index.js');
  await Insight.create({
    householdId, userId: null, type: 'merchant_spend_spike', severity: 'critical',
    title: 'Dining up 18%', description: 'Dining is up 18% versus the prior month.',
    entityType: null, entityId: null, status: 'open',
    fingerprint: 'count:dining-up-18', metadata: null, detectedAt: new Date(),
  });
  await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_audit', status: 'suggested',
    inputSnapshot: {}, output: { issues: [{ id: 1 }] },
  } as never);
  await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_fields', status: 'suggested',
    inputSnapshot: {}, output: {},
  } as never);
  // A dismissed Insight is the lifecycle equivalent of the retired
  // AiSuggestion status='superseded' row: it must not reach the badge.
  await Insight.create({
    householdId, userId: null, type: 'merchant_spend_spike', severity: 'info',
    title: 'Already dismissed', description: null,
    entityType: null, entityId: null, status: 'dismissed',
    fingerprint: 'count:dismissed', metadata: null, detectedAt: new Date(),
  });

  const r = await authed.get('/api/ai/inbox/count');
  assert.equal(r.status, 200);
  // The open Insight is NOT counted here: it is already counted and badged by
  // the insights surface itself (GET /api/insights?status=open). Counting it
  // in both places double-badged the same rows.
  assert.equal(r.body.total, 1);
  assert.equal(r.body.byKind.financial_insight, 0, 'insights never inflate the AI inbox count');
  assert.equal(r.body.byKind.transaction_audit, 1);
  assert.equal(r.body.byKind.rule_proposal, 0);
});

test('GET /api/ai/inbox/count scopes by household', async () => {
  // regularAgent is a non-superadmin with otherHouseholdId.
  // Suggestions from test 2 belong to householdId (superadmin's household) and must not appear.
  const { Insight } = await import('../../src/models/index.js');
  await Insight.create({
    householdId: otherHouseholdId, userId: null, type: 'category_trend', severity: 'info',
    title: 'Other household finding', description: null,
    entityType: null, entityId: null, status: 'open',
    fingerprint: 'count:other-household', metadata: null, detectedAt: new Date(),
  });
  const r = await regularAgent.get('/api/ai/inbox/count');
  assert.equal(r.status, 200);
  assert.equal(r.body.byKind.financial_insight, 0, 'insights are counted by their own endpoint');
  assert.equal(r.body.byKind.transaction_audit, 0);
  assert.equal(r.body.byKind.rule_proposal, 0);
  assert.equal(r.body.total, 0);
});

test('GET /api/ai/inbox returns audit rows and leaves open insights to the insights page', async () => {
  const { AiSuggestion, Insight } = await import('../../src/models/index.js');
  await Insight.create({
    householdId, userId: null, type: 'category_trend', severity: 'info',
    title: 'Older insight', description: 'An older finding.',
    entityType: null, entityId: null, status: 'open',
    fingerprint: 'inbox:older', metadata: null,
    detectedAt: new Date('2026-04-01T00:00:00Z'),
  });
  await Insight.create({
    householdId, userId: null, type: 'category_trend', severity: 'info',
    title: 'Newer insight', description: 'A newer finding.',
    entityType: null, entityId: null, status: 'open',
    fingerprint: 'inbox:newer', metadata: null,
    detectedAt: new Date('2026-05-01T00:00:00Z'),
  });
  const newerAudit = await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_audit', status: 'suggested',
    inputSnapshot: {},
    output: { issues: [{ id: 7, suggestedCategory: 'Dining', confidence: 'high' }, { id: 8 }] },
  } as never);

  const r = await authed.get('/api/ai/inbox');
  assert.equal(r.status, 200);
  const items = r.body.items as Array<{ id: number; kind: string; summary: string }>;
  // Open Insight rows are served by GET /api/insights and badged there; the AI
  // inbox is AiSuggestion-backed kinds only, so the same rows are not listed
  // (and counted) twice.
  assert.equal(
    items.filter((i) => i.kind === 'financial_insight').length,
    0,
    'open insights must not appear in the AI inbox',
  );
  const audit = items.find((i) => i.kind === 'transaction_audit' && i.id === newerAudit.id);
  assert.ok(audit);
  assert.match(audit.summary, /2 issue/);
});

test('GET /api/ai/inbox excludes insight rows and other suggestion kinds', async () => {
  const { AiSuggestion, Insight } = await import('../../src/models/index.js');
  // Ids are per-model sequences now, so identity is (kind, id), not id alone.
  const keysOf = (body: unknown) =>
    (body as { items: Array<{ id: number; kind: string }> }).items.map((i) => `${i.kind}:${i.id}`);
  const beforeR = await authed.get('/api/ai/inbox');
  assert.equal(beforeR.status, 200);
  const beforeKeys = new Set(keysOf(beforeR.body));

  const openInsight = await Insight.create({
    householdId, userId: null, type: 'recurring_fee', severity: 'warning',
    title: 'Open but not an inbox item', description: null,
    entityType: null, entityId: null, status: 'open',
    fingerprint: 'inbox:open-not-listed', metadata: null, detectedAt: new Date(),
  });
  const wrongKind = await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_fields', status: 'suggested',
    inputSnapshot: {}, output: {},
  } as never);

  const r = await authed.get('/api/ai/inbox');
  assert.equal(r.status, 200);
  const keys = keysOf(r.body);
  const kinds = (r.body.items as Array<{ kind: string }>).map((i) => i.kind);

  // These two noise rows must not appear in the response
  assert.ok(
    !keys.includes(`financial_insight:${openInsight.id}`),
    'no Insight row — open or otherwise — belongs in the AI inbox',
  );
  assert.ok(!keys.includes(`transaction_fields:${wrongKind.id}`), 'wrong-kind row must be excluded');

  // No new transaction_fields entries should have appeared
  assert.ok(!kinds.includes('transaction_fields'));

  // The response must still contain all the previously-visible items
  for (const key of beforeKeys) {
    assert.ok(keys.includes(key), `previously-visible item ${key} must still be present`);
  }
});

test('GET /api/ai/inbox scopes by household', async () => {
  const { AiSuggestion, Insight } = await import('../../src/models/index.js');
  await Insight.create({
    householdId: otherHouseholdId, userId: null, type: 'category_trend', severity: 'info',
    title: 'Other household', description: 'Belongs to the other household.',
    entityType: null, entityId: null, status: 'open',
    fingerprint: 'inbox:other-household', metadata: null, detectedAt: new Date(),
  });
  const ownAudit = await AiSuggestion.create({
    householdId: otherHouseholdId, userId: null, kind: 'transaction_audit',
    status: 'suggested', inputSnapshot: {}, output: { issues: [{ id: 1 }] },
  } as never);
  // regularAgent belongs to otherHouseholdId and is not superadmin, so it should only see
  // its own household's rows.
  const r = await regularAgent.get('/api/ai/inbox');
  assert.equal(r.status, 200);
  const items = r.body.items as Array<{ id: number; kind: string }>;
  assert.ok(
    items.some((i) => i.kind === 'transaction_audit' && i.id === ownAudit.id),
    'the other household\'s own audit row is visible to it',
  );
  assert.equal(
    items.filter((i) => i.kind === 'financial_insight').length,
    0,
    'insights are not part of the AI inbox for any household',
  );
  for (const item of items) {
    // rule_proposal / counterparty_promotion items carry synthesized negative ids.
    if (item.id < 0) continue;
    const row = await AiSuggestion.findByPk(item.id);
    assert.ok(row, `row ${item.kind}:${item.id} should exist`);
    assert.equal(
      row.householdId,
      otherHouseholdId,
      `row ${item.kind}:${item.id} must belong to otherHouseholdId`,
    );
  }
});

test('GET /api/ai/inbox includes rule_proposal items computed from transactions', async () => {
  const { Transaction, Account } = await import('../../src/models/index.js');
  const crypto = await import('crypto');
  const account = await Account.create({
    householdId, name: 'Inbox Test', owner: 'me', defaultCurrency: 'CAD',
  } as never);
  for (let i = 0; i < 3; i += 1) {
    await Transaction.create({
      householdId, accountId: account.id, currency: 'CAD',
      date: `2026-05-0${i + 1}`,
      merchantRaw: 'INBOX SHOP', merchantClean: 'INBOX SHOP',
      importBatch: 'inbox-test',
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      amount: -10,
      finalCategory: 'Groceries', finalBusiness: false, finalSplitType: 'me',
      reviewedAt: new Date(),
    } as never);
  }
  const r = await authed.get('/api/ai/inbox');
  const ruleItems = (r.body.items as Array<{ kind: string; summary: string }>)
    .filter((i) => i.kind === 'rule_proposal');
  assert.ok(ruleItems.length >= 1);
  assert.match(ruleItems[0].summary, /INBOX SHOP/);
});

test('POST /api/ai/rule-proposals/:pattern/dismiss persists rejection', async () => {
  const r = await authed.post('/api/ai/rule-proposals/INBOX%20SHOP/dismiss');
  assert.equal(r.status, 201);
  const { AiSuggestion } = await import('../../src/models/index.js');
  const stored = await AiSuggestion.findOne({
    where: { householdId, kind: 'rule_proposal', status: 'rejected' },
  });
  assert.ok(stored);
  assert.deepEqual(stored.inputSnapshot, { merchantPattern: 'INBOX SHOP' });
});

test('GET /api/ai/inbox excludes dismissed rule proposals', async () => {
  const r = await authed.get('/api/ai/inbox');
  const ruleItems = (r.body.items as Array<{ kind: string; summary: string }>)
    .filter((i) => i.kind === 'rule_proposal');
  assert.ok(!ruleItems.some((i) => i.summary.includes('INBOX SHOP')));
});

test('GET /api/ai/inbox/count includes non-dismissed rule proposals', async () => {
  const { Transaction, Account } = await import('../../src/models/index.js');
  const crypto = await import('crypto');
  const account = await Account.create({
    householdId, name: 'Inbox Test 2', owner: 'me', defaultCurrency: 'CAD',
  } as never);
  for (let i = 0; i < 3; i += 1) {
    await Transaction.create({
      householdId, accountId: account.id, currency: 'CAD',
      date: `2026-05-1${i}`,
      merchantRaw: 'COUNT ME', merchantClean: 'COUNT ME',
      importBatch: 'inbox-test-2',
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      amount: -8,
      finalCategory: 'Coffee', finalBusiness: false, finalSplitType: 'me',
      reviewedAt: new Date(),
    } as never);
  }
  const r = await authed.get('/api/ai/inbox/count');
  assert.ok(r.body.byKind.rule_proposal >= 1);
});

test('POST /api/ai/rule-proposals dismiss normalizes multi-space patterns', async () => {
  const { Transaction, Account } = await import('../../src/models/index.js');
  const crypto = await import('crypto');
  const account = await Account.create({
    householdId, name: 'Spaces Acct', owner: 'me', defaultCurrency: 'CAD',
  } as never);
  for (let i = 0; i < 3; i += 1) {
    await Transaction.create({
      householdId, accountId: account.id, currency: 'CAD',
      date: `2026-05-2${i}`,
      merchantRaw: 'SPACE  HOG', merchantClean: 'SPACE  HOG',
      importBatch: 'spaces-test',
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      amount: -5,
      finalCategory: 'Misc', finalBusiness: false, finalSplitType: 'me',
      reviewedAt: new Date(),
    } as never);
  }
  const before = await authed.get('/api/ai/inbox');
  const beforeProposals = (before.body.items as Array<{ kind: string; summary: string }>)
    .filter((i) => i.kind === 'rule_proposal' && i.summary.includes('SPACE HOG'));
  assert.ok(beforeProposals.length >= 1, 'proposal should appear with collapsed-whitespace pattern');

  const dismissRes = await authed.post('/api/ai/rule-proposals/SPACE%20%20HOG/dismiss');
  assert.equal(dismissRes.status, 201);

  const after = await authed.get('/api/ai/inbox');
  const afterProposals = (after.body.items as Array<{ kind: string; summary: string }>)
    .filter((i) => i.kind === 'rule_proposal' && i.summary.includes('SPACE HOG'));
  assert.equal(afterProposals.length, 0, 'multi-space dismiss should exclude collapsed-space proposal');
});

test('GET /api/ai/inbox hides transaction_audit rows with zero issues', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  const empty = await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_audit', status: 'suggested',
    inputSnapshot: {}, output: { issues: [] },
  } as never);
  const r = await authed.get('/api/ai/inbox');
  // Compare on (kind, id): Insight and AiSuggestion ids come from different
  // sequences, so a bare id can collide across kinds.
  const keys = (r.body.items as Array<{ id: number; kind: string }>)
    .map((i) => `${i.kind}:${i.id}`);
  assert.ok(
    !keys.includes(`transaction_audit:${empty.id}`),
    'empty audit row must not appear in inbox',
  );
});

test('GET /api/ai/inbox/count excludes transaction_audit rows with zero issues', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  const before = await authed.get('/api/ai/inbox/count');
  const beforeAudit = before.body.byKind.transaction_audit;
  await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_audit', status: 'suggested',
    inputSnapshot: {}, output: { issues: [] },
  } as never);
  const after = await authed.get('/api/ai/inbox/count');
  assert.equal(after.body.byKind.transaction_audit, beforeAudit, 'empty audit must not bump count');
});

test('GET /api/ai/inbox never lists open Insight rows (they have their own surface)', async () => {
  const { Insight } = await import('../../src/models/index.js');
  const critical = await Insight.create({
    householdId, userId: null, type: 'duplicate_transactions', severity: 'critical',
    title: 'Possible duplicate charge',
    description: 'Two identical $42 charges at Loblaws on the same day.',
    entityType: null, entityId: null, status: 'open',
    fingerprint: 'inbox:mapping-described', metadata: null,
    detectedAt: new Date('2026-10-02T00:00:00Z'),
  });
  const warning = await Insight.create({
    householdId, userId: null, type: 'small_subscription', severity: 'warning',
    title: 'Small subscription still billing',
    description: null,
    entityType: null, entityId: null, status: 'open',
    fingerprint: 'inbox:mapping-bare', metadata: null,
    detectedAt: new Date('2026-10-01T00:00:00Z'),
  });

  const r = await authed.get('/api/ai/inbox');
  assert.equal(r.status, 200);
  const keys = (r.body.items as Array<{ id: number; kind: string }>)
    .map((i) => `${i.kind}:${i.id}`);
  // The AI inbox is AiSuggestion-backed only. Insights are listed, counted and
  // badged by the insights surface (GET /api/insights); mirroring them here
  // made the sidebar badge the same rows twice.
  assert.ok(!keys.includes(`financial_insight:${critical.id}`));
  assert.ok(!keys.includes(`financial_insight:${warning.id}`));

  // ...and the count endpoint agrees.
  const c = await authed.get('/api/ai/inbox/count');
  assert.equal(c.body.byKind.financial_insight, 0);
});

test('GET /api/transactions?ids=1,2 filters to listed ids', async () => {
  const { Transaction, Account } = await import('../../src/models/index.js');
  const crypto = await import('crypto');
  const account = await Account.create({
    householdId, name: 'IDs Account', owner: 'me', defaultCurrency: 'CAD',
  } as never);
  const a = await Transaction.create({
    householdId, accountId: account.id, currency: 'CAD',
    date: '2026-05-01', merchantRaw: 'A', merchantClean: 'A',
    importBatch: 'ids-test', sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    amount: -1, finalCategory: 'X', finalBusiness: false, finalSplitType: 'me',
  } as never);
  const b = await Transaction.create({
    householdId, accountId: account.id, currency: 'CAD',
    date: '2026-05-02', merchantRaw: 'B', merchantClean: 'B',
    importBatch: 'ids-test', sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    amount: -2, finalCategory: 'Y', finalBusiness: false, finalSplitType: 'me',
  } as never);
  await Transaction.create({
    householdId, accountId: account.id, currency: 'CAD',
    date: '2026-05-03', merchantRaw: 'C', merchantClean: 'C',
    importBatch: 'ids-test', sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    amount: -3, finalCategory: 'Z', finalBusiness: false, finalSplitType: 'me',
  } as never);

  const r = await authed.get(`/api/transactions?ids=${a.id},${b.id}`);
  assert.equal(r.status, 200);
  const ids = (r.body.data as Array<{ id: number }>).map((t) => t.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
});

test('GET /api/transactions?ids= ignores empty/invalid entries gracefully', async () => {
  const r = await authed.get('/api/transactions?ids=abc,,999999');
  assert.equal(r.status, 200);
  assert.equal((r.body.data as unknown[]).length, 0);
});
