/**
 * Integration tests for instalment payment routes and multi-year compare.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-tax-instalments.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let entityId: number;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models/index.js');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');

  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `tax-instalments-${Date.now()}@example.com`,
    displayName: 'Instalment Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Instalment Test HH' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });

  // Create a personal entity
  const entity = await (models.Entity.create as any)({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Instalment Tester',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  entityId = entity.id;

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });

  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

test('GET /api/tax/personal/2025/instalments without auth returns 401', async () => {
  const res = await request(app).get('/api/tax/personal/2025/instalments');
  assert.equal(res.status, 401);
});

test('GET /api/tax/personal/2025/instalments with auth returns empty array initially', async () => {
  const res = await authed.get('/api/tax/personal/2025/instalments');
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body.instalments));
  assert.equal(res.body.instalments.length, 0);
});

test('POST /api/tax/personal/2025/instalments creates a payment', async () => {
  const res = await authed.post('/api/tax/personal/2025/instalments').send({
    quarter: 1,
    amount: '2500.00',
    paidOn: '2025-03-15',
    notes: 'Q1 instalment',
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.instalment);
  assert.equal(String(res.body.instalment.year), '2025');
  assert.equal(String(res.body.instalment.quarter), '1');
  assert.equal(res.body.instalment.paidOn, '2025-03-15');
  assert.ok(res.body.instalment.id);
});

test('POST /api/tax/personal/2025/instalments: second payment', async () => {
  const res = await authed.post('/api/tax/personal/2025/instalments').send({
    quarter: 2,
    amount: '3000.00',
    paidOn: '2025-06-15',
    notes: null,
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('GET /api/tax/personal/2025/instalments returns both payments', async () => {
  const res = await authed.get('/api/tax/personal/2025/instalments');
  assert.equal(res.status, 200);
  assert.equal(res.body.instalments.length, 2);
  // Ordered by paidOn ascending
  assert.equal(res.body.instalments[0].paidOn, '2025-03-15');
  assert.equal(res.body.instalments[1].paidOn, '2025-06-15');
});

test('POST /api/tax/personal/2025/instalments missing amount returns 400', async () => {
  const res = await authed.post('/api/tax/personal/2025/instalments').send({
    quarter: 3,
    paidOn: '2025-09-15',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'missing_fields');
});

test('POST /api/tax/personal/2025/instalments missing paidOn returns 400', async () => {
  const res = await authed.post('/api/tax/personal/2025/instalments').send({
    amount: '1000.00',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'missing_fields');
});

test('POST /api/tax/personal/invalid/instalments returns 400', async () => {
  const res = await authed.post('/api/tax/personal/invalid/instalments').send({
    amount: '1000.00',
    paidOn: '2025-01-01',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_year');
});

test('GET /api/tax/personal/years returns multi-year compare', async () => {
  const res = await authed.get('/api/tax/personal/years?from=2023&to=2026');
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body.years), 'expected years array');
  // No snapshots seeded, so array should be empty
  assert.equal(res.body.years.length, 0);
});

test('GET /api/tax/personal/years without auth returns 401', async () => {
  const res = await request(app).get('/api/tax/personal/years');
  assert.equal(res.status, 401);
});

test('POST /api/tax/personal/2025/roll-forward without auth returns 401', async () => {
  const res = await request(app).post('/api/tax/personal/2025/roll-forward');
  assert.equal(res.status, 401);
});

test('POST /api/tax/personal/2025/roll-forward with auth returns 200 and written carryforwards', async () => {
  const res = await authed.post('/api/tax/personal/2025/roll-forward');
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.rolled, true);
  assert.equal(res.body.year, 2025);
  assert.ok(Array.isArray(res.body.written));
  assert.ok(res.body.written.length > 0);
  const kinds = res.body.written.map((w: { kind: string }) => w.kind);
  assert.ok(kinds.includes('cap_loss'));
  assert.ok(kinds.includes('rrsp_room'));
  assert.ok(kinds.includes('fhsa_room'));
});

test('POST /api/tax/personal/2099/roll-forward returns 409 for missing rate table', async () => {
  const res = await authed.post('/api/tax/personal/2099/roll-forward');
  assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'rate_table_missing');
});
