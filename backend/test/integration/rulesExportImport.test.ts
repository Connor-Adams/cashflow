/**
 * Integration tests for the merchant-rule JSON export/import surface
 * (issue #438): GET /api/rules/export and POST /api/rules/import.
 *
 * Run in isolation (`yarn test:integration`) so DATABASE_URL is set before
 * any Sequelize import.
 *
 * Bootstraps a superadmin (first-registered-user shortcut), then seeds a
 * regular household whose session cookie drives the request agent. Each test
 * resets the household's rules so cases don't bleed into one another.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let householdId: number;
let RuleModel: typeof import('../../src/models').Rule;

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('rules-export-import');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // First-registered user becomes superadmin; we don't drive it — we just
  // want a regular household session next.
  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const models = await import('../../src/models');
  RuleModel = models.Rule;
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `rules-ei-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: 'Rules Owner',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Rules export household' });
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
  agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

beforeEach(async () => {
  // Each test starts from a clean rule set for this household.
  await RuleModel.destroy({ where: { householdId } });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function seedRule(overrides: Record<string, unknown> = {}) {
  const res = await agent.post('/api/rules').send({
    merchantPattern: 'NETFLIX',
    category: 'Subscriptions',
    ...overrides,
  });
  assert.equal(res.status, 201, `seedRule failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

// AC #1, #2 — export returns the right shape, omits server-only fields.
test('GET /api/rules/export returns schemaVersion, timestamp, and all rules', async () => {
  await seedRule({ merchantPattern: 'NETFLIX', category: 'Subscriptions', priority: 5 });
  await seedRule({ merchantPattern: 'UBER', category: 'Transport', priority: 1 });

  const res = await agent.get('/api/rules/export');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type']?.includes('application/json'), true);
  assert.match(
    String(res.headers['content-disposition']),
    /attachment; filename="cashflow-rules-\d{4}-\d{2}-\d{2}\.json"/,
  );

  assert.equal(res.body.schemaVersion, 1);
  assert.match(String(res.body.exportedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof res.body.exportedBy, 'string');
  assert.ok(res.body.exportedBy.length > 0);

  assert.equal(Array.isArray(res.body.rules), true);
  assert.equal(res.body.rules.length, 2);

  const patterns = res.body.rules.map((r: { merchantPattern: string }) => r.merchantPattern).sort();
  assert.deepEqual(patterns, ['NETFLIX', 'UBER']);

  // AC #2 — server-only fields must be omitted from every exported rule.
  for (const r of res.body.rules) {
    assert.equal('id' in r, false, 'exported rule must not include id');
    assert.equal('createdAt' in r, false, 'exported rule must not include createdAt');
    assert.equal('hitCount' in r, false, 'exported rule must not include hitCount');
    assert.equal('usageCount' in r, false, 'exported rule must not include usageCount');
    assert.equal('householdId' in r, false, 'exported rule must not include householdId');
    // Whitelisted fields are present:
    assert.equal(typeof r.merchantPattern, 'string');
    assert.equal(typeof r.matchKind, 'string');
  }
});

test('GET /api/rules/export returns an empty rules array when the user has none', async () => {
  const res = await agent.get('/api/rules/export');
  assert.equal(res.status, 200);
  assert.equal(res.body.schemaVersion, 1);
  assert.deepEqual(res.body.rules, []);
});

// AC #4 — append mode inserts; name collision gets the dated suffix.
test('POST /api/rules/import append inserts rules and suffixes name collisions', async () => {
  await seedRule({ merchantPattern: 'NETFLIX', category: 'Subscriptions' });

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    rules: [
      { merchantPattern: 'NETFLIX', matchKind: 'substring', priority: 0, category: 'Streaming', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
      { merchantPattern: 'SPOTIFY', matchKind: 'substring', priority: 0, category: 'Music', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
    ],
  };

  const res = await agent.post('/api/rules/import').send({ mode: 'append', json: payload });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 2);
  assert.equal(res.body.skipped, 0);
  assert.deepEqual(res.body.errors, []);

  const all = await RuleModel.findAll({ where: { householdId } });
  const patterns = all.map((r) => r.merchantPattern).sort();
  const today = new Date().toISOString().slice(0, 10);
  // Original NETFLIX, the colliding import suffixed, and SPOTIFY.
  assert.equal(patterns.includes('NETFLIX'), true);
  assert.equal(patterns.includes(`NETFLIX (imported ${today})`), true);
  assert.equal(patterns.includes('SPOTIFY'), true);
  assert.equal(all.length, 3);
});

// AC #5 — replace deletes existing and inserts; rolls back on per-rule failure.
test('POST /api/rules/import replace deletes existing rules then inserts the new set', async () => {
  await seedRule({ merchantPattern: 'OLD_ONE', category: 'X' });
  await seedRule({ merchantPattern: 'OLD_TWO', category: 'Y' });

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    rules: [
      { merchantPattern: 'FRESH', matchKind: 'substring', priority: 0, category: 'New', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
    ],
  };

  const res = await agent.post('/api/rules/import').send({ mode: 'replace', json: payload });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 1);

  const all = await RuleModel.findAll({ where: { householdId } });
  const patterns = all.map((r) => r.merchantPattern);
  assert.deepEqual(patterns, ['FRESH']);
});

test('POST /api/rules/import replace rolls back the delete when an insert fails', async () => {
  await seedRule({ merchantPattern: 'KEEP_ME', category: 'X' });

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    rules: [
      { merchantPattern: 'A', matchKind: 'substring', priority: 0, category: 'a', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
      { merchantPattern: 'B', matchKind: 'substring', priority: 0, category: 'b', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
    ],
  };

  // Force the second insert inside the replace transaction to throw, so we can
  // prove the whole operation (including the prior DELETE of existing rules)
  // rolls back: the pre-existing KEEP_ME rule must survive untouched and no
  // partial new rows are left behind.
  const originalCreate = RuleModel.create.bind(RuleModel);
  let createCalls = 0;
  const spy = (...args: Parameters<typeof RuleModel.create>) => {
    createCalls += 1;
    if (createCalls === 2) {
      return Promise.reject(new Error('boom: simulated insert failure'));
    }
    return originalCreate(...args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (RuleModel as any).create = spy;

  try {
    const res = await agent.post('/api/rules/import').send({ mode: 'replace', json: payload });
    assert.equal(res.status, 500);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (RuleModel as any).create = originalCreate;
  }

  const after = await RuleModel.findAll({ where: { householdId } });
  assert.deepEqual(
    after.map((r) => r.merchantPattern),
    ['KEEP_ME'],
    'replace must roll back its delete when an insert throws',
  );
});

// AC #8 — bad / unsupported schemaVersion is rejected; no DB write.
test('POST /api/rules/import rejects a newer schemaVersion with 400 and no write', async () => {
  await seedRule({ merchantPattern: 'UNTOUCHED', category: 'X' });

  const res = await agent.post('/api/rules/import').send({
    mode: 'append',
    json: { schemaVersion: 99, exportedAt: new Date().toISOString(), rules: [] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'UNSUPPORTED_VERSION');

  const all = await RuleModel.findAll({ where: { householdId } });
  assert.equal(all.length, 1);
  assert.equal(all[0].merchantPattern, 'UNTOUCHED');
});

test('POST /api/rules/import rejects an invalid mode with 400', async () => {
  const res = await agent.post('/api/rules/import').send({
    mode: 'merge',
    json: { schemaVersion: 1, exportedAt: new Date().toISOString(), rules: [] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_MODE');
});

test('POST /api/rules/import rejects a missing json body with 400', async () => {
  const res = await agent.post('/api/rules/import').send({ mode: 'append' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_JSON');
});

// AC #9 — per-rule validation failures appear in errors, valid rules still import.
test('POST /api/rules/import reports per-rule validation failures in errors[]', async () => {
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    rules: [
      { merchantPattern: 'GOOD', matchKind: 'substring', priority: 0, category: 'OK', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
      // Missing merchantPattern → must be skipped and listed in errors.
      { matchKind: 'substring', priority: 0, category: 'Bad', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
      // Malformed effectiveFrom → skipped and listed in errors.
      { merchantPattern: 'BADDATE', matchKind: 'substring', priority: 0, category: 'Bad', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: 'not-a-date', effectiveTo: null },
    ],
  };

  const res = await agent.post('/api/rules/import').send({ mode: 'append', json: payload });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.skipped, 2);
  assert.equal(res.body.errors.length, 2);
  for (const err of res.body.errors) {
    assert.equal(typeof err.name, 'string');
    assert.equal(typeof err.reason, 'string');
  }

  const all = await RuleModel.findAll({ where: { householdId } });
  assert.deepEqual(all.map((r) => r.merchantPattern), ['GOOD']);
});

// AC #1 round-trip — export then import (replace) reproduces the rule set.
test('export → import replace round-trips a rule set', async () => {
  await seedRule({ merchantPattern: 'ROUNDTRIP', category: 'Subscriptions', priority: 7, matchKind: 'substring' });

  const exported = await agent.get('/api/rules/export');
  assert.equal(exported.status, 200);

  // Wipe and re-import from the exported payload.
  const res = await agent.post('/api/rules/import').send({ mode: 'replace', json: exported.body });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 1);

  const all = await RuleModel.findAll({ where: { householdId } });
  assert.equal(all.length, 1);
  assert.equal(all[0].merchantPattern, 'ROUNDTRIP');
  assert.equal(all[0].priority, 7);
  assert.equal(all[0].category, 'Subscriptions');
});
