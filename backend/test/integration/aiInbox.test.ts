/**
 * Integration tests for /api/ai/inbox*. Runs in isolation
 * (`yarn test:integration`) against a per-file Postgres database provisioned
 * by setupPgTestDb (sets DATABASE_URL before any Sequelize import).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
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
  authed = request.agent(app);
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
  regularAgent = request.agent(app);
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
    byKind: { transaction_audit: 0, financial_insight: 0, rule_proposal: 0 },
  });
});

test('GET /api/ai/inbox/count counts only suggested rows in the three kinds', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  await AiSuggestion.create({
    householdId, userId: null, kind: 'financial_insight', status: 'suggested',
    inputSnapshot: { period: '2026-05', currency: 'CAD' },
    output: [{ title: 'Dining up 18%', severity: 'action' }],
  } as never);
  await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_audit', status: 'suggested',
    inputSnapshot: {}, output: { issues: [{ id: 1 }] },
  } as never);
  await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_fields', status: 'suggested',
    inputSnapshot: {}, output: {},
  } as never);
  await AiSuggestion.create({
    householdId, userId: null, kind: 'financial_insight', status: 'superseded',
    inputSnapshot: {}, output: [],
  } as never);

  const r = await authed.get('/api/ai/inbox/count');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  assert.equal(r.body.byKind.financial_insight, 1);
  assert.equal(r.body.byKind.transaction_audit, 1);
  assert.equal(r.body.byKind.rule_proposal, 0);
});

test('GET /api/ai/inbox/count scopes by household', async () => {
  // regularAgent is a non-superadmin with otherHouseholdId.
  // Suggestions from test 2 belong to householdId (superadmin's household) and must not appear.
  const { AiSuggestion } = await import('../../src/models/index.js');
  await AiSuggestion.create({
    householdId: otherHouseholdId, userId: null, kind: 'financial_insight', status: 'suggested',
    inputSnapshot: {}, output: [],
  } as never);
  const r = await regularAgent.get('/api/ai/inbox/count');
  assert.equal(r.status, 200);
  assert.equal(r.body.byKind.financial_insight, 1);
  assert.equal(r.body.byKind.transaction_audit, 0);
  assert.equal(r.body.byKind.rule_proposal, 0);
});

test('GET /api/ai/inbox returns audit + insight suggested rows newest first', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  const olderInsight = await AiSuggestion.create({
    householdId, userId: null, kind: 'financial_insight', status: 'suggested',
    inputSnapshot: { period: '2026-04', currency: 'CAD' },
    output: [{ title: 'Older insight', severity: 'info', supportingTransactionIds: [] }],
  } as never);
  const newerAudit = await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_audit', status: 'suggested',
    inputSnapshot: {},
    output: { issues: [{ id: 7, suggestedCategory: 'Dining', confidence: 'high' }, { id: 8 }] },
  } as never);

  const r = await authed.get('/api/ai/inbox');
  assert.equal(r.status, 200);
  const items = r.body.items as Array<{ id: number; kind: string; summary: string }>;
  const ids = items.map((i) => i.id);
  assert.ok(ids.indexOf(newerAudit.id) < ids.indexOf(olderInsight.id), 'newer first');
  const audit = items.find((i) => i.id === newerAudit.id);
  assert.ok(audit);
  assert.equal(audit.kind, 'transaction_audit');
  assert.match(audit.summary, /2 issue/);
});

test('GET /api/ai/inbox excludes non-suggested status and other kinds', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  const beforeR = await authed.get('/api/ai/inbox');
  assert.equal(beforeR.status, 200);
  const beforeIds = new Set((beforeR.body.items as Array<{ id: number }>).map((i) => i.id));

  const rejected = await AiSuggestion.create({
    householdId, userId: null, kind: 'financial_insight', status: 'rejected',
    inputSnapshot: {}, output: [],
  } as never);
  const wrongKind = await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_fields', status: 'suggested',
    inputSnapshot: {}, output: {},
  } as never);

  const r = await authed.get('/api/ai/inbox');
  assert.equal(r.status, 200);
  const ids = (r.body.items as Array<{ id: number }>).map((i) => i.id);
  const kinds = (r.body.items as Array<{ kind: string }>).map((i) => i.kind);

  // These two noise rows must not appear in the response
  assert.ok(!ids.includes(rejected.id), 'rejected row must be excluded');
  assert.ok(!ids.includes(wrongKind.id), 'wrong-kind row must be excluded');

  // No new transaction_fields entries should have appeared
  assert.ok(!kinds.includes('transaction_fields'));

  // The response must still contain all the previously-visible items
  for (const id of beforeIds) {
    assert.ok(ids.includes(id), `previously-visible item ${id} must still be present`);
  }
});

test('GET /api/ai/inbox scopes by household', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  await AiSuggestion.create({
    householdId: otherHouseholdId, userId: null, kind: 'financial_insight', status: 'suggested',
    inputSnapshot: { period: '2026-05', currency: 'CAD' },
    output: [{ title: 'Other household' }],
  } as never);
  // regularAgent belongs to otherHouseholdId and is not superadmin, so it should only see
  // its own household's suggestions.
  const r = await regularAgent.get('/api/ai/inbox');
  assert.equal(r.status, 200);
  // authed (superadmin) may see everything; use regularAgent to check scoping
  const titles = (r.body.items as Array<{ summary: string }>).map((i) => i.summary);
  // The otherHouseholdId suggestion summary should be present for regularAgent (it's theirs)
  // but suggestions belonging to householdId (superadmin's household) must not appear.
  const r2 = await authed.get('/api/ai/inbox');
  const authedIds = (r2.body.items as Array<{ id: number }>).map((i) => i.id);
  const regularIds = (r.body.items as Array<{ id: number }>).map((i) => i.id);
  // No overlap: regularAgent must not see householdId rows, authed (superadmin) sees all
  // Just verify regularAgent's items don't include any rows from householdId.
  // We do this by checking that every item regularAgent sees belongs to otherHouseholdId.
  const { AiSuggestion: AS2 } = await import('../../src/models/index.js');
  for (const id of regularIds) {
    const row = await AS2.findByPk(id);
    assert.ok(row, `row ${id} should exist`);
    assert.equal(row!.householdId, otherHouseholdId, `row ${id} must belong to otherHouseholdId`);
  }
  void titles; // used above for context
  void authedIds; // not needed for the assertion
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

test('POST /api/ai/insights supersedes prior suggested rows for same period+currency', async () => {
  await authed.get('/api/ai/insights?period=2026-03&currency=CAD');
  await authed.get('/api/ai/insights?period=2026-03&currency=CAD');
  await authed.get('/api/ai/insights?period=2026-03&currency=CAD');

  const { AiSuggestion } = await import('../../src/models/index.js');
  const suggested = await AiSuggestion.findAll({
    where: { householdId, kind: 'financial_insight', status: 'suggested' },
  });
  const for2026_03_CAD = suggested.filter((row) => {
    const snap = row.inputSnapshot as { period?: string; currency?: string };
    return snap?.period === '2026-03' && snap?.currency === 'CAD';
  });
  assert.equal(for2026_03_CAD.length, 1, 'exactly one suggested row per (period, currency)');

  const superseded = await AiSuggestion.findAll({
    where: { householdId, kind: 'financial_insight', status: 'superseded' },
  });
  const supersededFor2026_03 = superseded.filter((row) => {
    const snap = row.inputSnapshot as { period?: string; currency?: string };
    return snap?.period === '2026-03' && snap?.currency === 'CAD';
  });
  assert.equal(supersededFor2026_03.length, 2, 'two superseded rows from earlier loads');
});

test('POST /api/ai/insights does not supersede rows for a different period', async () => {
  await authed.get('/api/ai/insights?period=2026-02&currency=CAD');
  await authed.get('/api/ai/insights?period=2026-03&currency=CAD');

  const { AiSuggestion } = await import('../../src/models/index.js');
  const feb = await AiSuggestion.findAll({
    where: { householdId, kind: 'financial_insight', status: 'suggested' },
  });
  const stillSuggestedFeb = feb.filter((row) => {
    const snap = row.inputSnapshot as { period?: string };
    return snap?.period === '2026-02';
  });
  assert.equal(stillSuggestedFeb.length, 1, 'Feb row was not superseded by Mar refresh');
});

test('GET /api/ai/inbox hides transaction_audit rows with zero issues', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  const empty = await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_audit', status: 'suggested',
    inputSnapshot: {}, output: { issues: [] },
  } as never);
  const r = await authed.get('/api/ai/inbox');
  const ids = (r.body.items as Array<{ id: number }>).map((i) => i.id);
  assert.ok(!ids.includes(empty.id), 'empty audit row must not appear in inbox');
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

test('GET /api/ai/inbox lazy-supersedes financial_insight duplicates per (period, currency)', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  const dupes = await Promise.all([
    AiSuggestion.create({
      householdId, userId: null, kind: 'financial_insight', status: 'suggested',
      inputSnapshot: { period: '2026-09', currency: 'CAD' },
      output: [{ title: 'Dup A' }],
    } as never),
    AiSuggestion.create({
      householdId, userId: null, kind: 'financial_insight', status: 'suggested',
      inputSnapshot: { period: '2026-09', currency: 'CAD' },
      output: [{ title: 'Dup B' }],
    } as never),
    AiSuggestion.create({
      householdId, userId: null, kind: 'financial_insight', status: 'suggested',
      inputSnapshot: { period: '2026-09', currency: 'CAD' },
      output: [{ title: 'Dup C' }],
    } as never),
  ]);

  await authed.get('/api/ai/inbox');

  const refreshed = await AiSuggestion.findAll({
    where: { id: dupes.map((d) => d.id) },
    order: [['id', 'ASC']],
  });
  assert.equal(refreshed[0].status, 'superseded', 'oldest dupe is superseded');
  assert.equal(refreshed[1].status, 'superseded', 'middle dupe is superseded');
  assert.equal(refreshed[2].status, 'suggested', 'newest dupe is kept');
});

test('GET /api/ai/inbox summarizes financial_insight with severity breakdown', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  await AiSuggestion.create({
    householdId, userId: null, kind: 'financial_insight', status: 'suggested',
    inputSnapshot: { period: '2026-10', currency: 'CAD' },
    output: [
      { title: 'Top thing', severity: 'action' },
      { title: 'Second', severity: 'action' },
      { title: 'Third', severity: 'watch' },
      { title: 'Fourth', severity: 'info' },
    ],
  } as never);
  const r = await authed.get('/api/ai/inbox');
  const items = r.body.items as Array<{ summary: string; severity: string | null }>;
  const it = items.find((i) => i.summary.startsWith('Top thing'));
  assert.ok(it, 'inserted insight must appear in inbox');
  assert.match(it.summary, /2 action/);
  assert.match(it.summary, /1 watch/);
  assert.match(it.summary, /1 info/);
  assert.doesNotMatch(it.summary, /\+\d+ more/, 'should no longer use "+N more" suffix');
  assert.equal(it.severity, 'action', 'top-row severity is the highest across the array');
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
