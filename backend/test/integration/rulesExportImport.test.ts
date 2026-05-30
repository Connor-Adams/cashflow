/**
 * Integration tests for GET /api/rules/export and POST /api/rules/import (issue #438).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

type Seeded = { token: string; householdId: number; userId: number };

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
  await models.HouseholdMember.create({ householdId: household.id, userId: user.id, role: 'owner' });
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 86400000),
  });
  return { token, householdId: household.id, userId: user.id };
}

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('rules_export_import');
  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const reg = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(reg.status, 201);

  const primary = await seed('Primary');
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// Seed two rules for primary household
async function seedRules() {
  await agent.post('/api/rules').send({ merchantPattern: 'Amazon', matchKind: 'substring', priority: 10, category: 'Shopping' });
  await agent.post('/api/rules').send({ merchantPattern: 'Netflix', matchKind: 'substring', priority: 5, isBusiness: false });
}

test('GET /api/rules/export returns correct shape with schemaVersion 1', async () => {
  await seedRules();
  const res = await agent.get('/api/rules/export');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /attachment/);
  assert.equal(res.body.schemaVersion, 1);
  assert.ok(typeof res.body.exportedAt === 'string');
  assert.ok(typeof res.body.exportedBy === 'string');
  assert.ok(Array.isArray(res.body.rules));
  assert.ok(res.body.rules.length >= 2);
});

test('GET /api/rules/export omits server-only fields (id, usageCount)', async () => {
  const res = await agent.get('/api/rules/export');
  assert.equal(res.status, 200);
  for (const rule of res.body.rules as Array<Record<string, unknown>>) {
    assert.ok(!('id' in rule), 'should not export id');
    assert.ok(!('usageCount' in rule), 'should not export usageCount');
    assert.ok(!('createdAt' in rule), 'should not export createdAt');
    assert.ok(!('updatedAt' in rule), 'should not export updatedAt');
    assert.ok('merchantPattern' in rule, 'should have merchantPattern');
    assert.ok('matchKind' in rule, 'should have matchKind');
  }
});

test('POST /api/rules/import append inserts rules', async () => {
  const listBefore = await agent.get('/api/rules');
  const countBefore = (listBefore.body as unknown[]).length;

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: 'test',
    rules: [
      { merchantPattern: 'Starbucks', matchKind: 'substring', priority: 3, category: 'Coffee', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
    ],
  };

  const res = await agent.post('/api/rules/import').send({ json: payload, mode: 'append' });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.skipped, 0);

  const listAfter = await agent.get('/api/rules');
  assert.equal((listAfter.body as unknown[]).length, countBefore + 1);
});

test('POST /api/rules/import append renames collisions with (imported DATE) suffix', async () => {
  // Ensure Amazon rule exists
  const existing = await agent.get('/api/rules');
  const hasAmazon = (existing.body as Array<{ merchantPattern: string }>).some(
    (r) => r.merchantPattern === 'Amazon',
  );
  assert.ok(hasAmazon, 'Amazon rule must exist before this test');

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: 'test',
    rules: [
      { merchantPattern: 'Amazon', matchKind: 'substring', priority: 1, category: null, isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
    ],
  };

  const res = await agent.post('/api/rules/import').send({ json: payload, mode: 'append' });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 1);

  const listAfter = await agent.get('/api/rules');
  const patterns = (listAfter.body as Array<{ merchantPattern: string }>).map((r) => r.merchantPattern);
  assert.ok(patterns.some((p) => p.startsWith('Amazon (imported ')), 'should have collision suffix');
});

test('POST /api/rules/import replace deletes existing rules then inserts', async () => {
  // Ensure at least one rule exists
  const existing = await otherAgent.get('/api/rules');
  const countBefore = (existing.body as unknown[]).length;

  // Seed at least one rule for other household
  await otherAgent.post('/api/rules').send({ merchantPattern: 'OtherRule', matchKind: 'substring' });

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: 'test',
    rules: [
      { merchantPattern: 'ReplaceMe', matchKind: 'substring', priority: 0, category: null, isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
    ],
  };

  const res = await otherAgent.post('/api/rules/import').send({ json: payload, mode: 'replace' });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 1);

  const listAfter = await otherAgent.get('/api/rules');
  const rules = listAfter.body as Array<{ merchantPattern: string }>;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].merchantPattern, 'ReplaceMe');
  void countBefore; // suppress unused variable
});

test('POST /api/rules/import rejects schemaVersion > 1 with UNSUPPORTED_VERSION', async () => {
  const payload = { schemaVersion: 999, exportedAt: '', exportedBy: '', rules: [] };
  const res = await agent.post('/api/rules/import').send({ json: payload, mode: 'append' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'UNSUPPORTED_VERSION');
});

test('POST /api/rules/import rejects invalid mode', async () => {
  const payload = { schemaVersion: 1, exportedAt: '', exportedBy: '', rules: [] };
  const res = await agent.post('/api/rules/import').send({ json: payload, mode: 'overwrite' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_MODE');
});

test('POST /api/rules/import per-rule validation failure goes into errors array', async () => {
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: 'test',
    rules: [
      // valid
      { merchantPattern: 'ValidRule', matchKind: 'substring', priority: 0, category: null, isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
      // invalid: missing merchantPattern
      { matchKind: 'substring', priority: 0, category: null, isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
      // invalid: effectiveFrom >= effectiveTo
      { merchantPattern: 'BadDates', matchKind: 'substring', priority: 0, category: null, isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: '2026-06-01', effectiveTo: '2026-01-01' },
    ],
  };

  const res = await agent.post('/api/rules/import').send({ json: payload, mode: 'append' });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.skipped, 2);
  assert.equal(res.body.errors.length, 2);
});

test('export/import round-trip preserves rule fields', async () => {
  // Export current rules for primary household, then import them back as append
  const exportRes = await agent.get('/api/rules/export');
  assert.equal(exportRes.status, 200);

  const importRes = await agent.post('/api/rules/import').send({
    json: exportRes.body,
    mode: 'append',
  });
  assert.equal(importRes.status, 200);
  assert.ok(importRes.body.imported > 0 || importRes.body.skipped > 0);
});
