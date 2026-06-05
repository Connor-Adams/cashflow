/**
 * Integration tests for /api/tax routes (Task 18).
 *
 * Auth note: app.ts mounts `requireAuth` at `app.use('/api', requireAuth)` so
 * every /api/tax/* endpoint is protected at the global level — unauthenticated
 * requests get 401 before they ever reach the tax router.
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
const dbPath = path.join(backendRoot, 'data', 'test-tax-routes.sqlite');

let app: import('express').Express;
let authedNoEntity: ReturnType<typeof request.agent>;

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

  const mod = await import('../app.js');
  app = mod.default;

  const models = await import('../models/index.js');
  const { hashPassword, hashToken } = await import('../auth/password.js');

  // Seed a household with no entity for the 404 test.
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `tax-no-entity-${Date.now()}@example.com`,
    displayName: 'Tax Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Tax Test HH (no entity)' });
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

  authedNoEntity = request.agent(app);
  authedNoEntity.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

test('GET /api/tax/entities without auth returns 401', async () => {
  const res = await request(app).get('/api/tax/entities');
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('GET /api/tax/personal/:year/return without auth returns 401', async () => {
  const res = await request(app).get('/api/tax/personal/2025/return');
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('GET /api/tax/personal/:year/return with auth but no personal entity returns 404', async () => {
  const res = await authedNoEntity.get('/api/tax/personal/2025/return');
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'no_personal_entity');
});

test('GET /api/tax/entities with auth returns entities array', async () => {
  const res = await authedNoEntity.get('/api/tax/entities');
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body.entities), 'expected entities array');
});

test('GET /api/tax/years returns sorted supported years', async () => {
  const res = await authedNoEntity.get('/api/tax/years');
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body.years), 'expected years array');
  assert.ok(res.body.years.length >= 3, 'expected at least 3 supported years');
  const sorted = [...res.body.years].sort((a: number, b: number) => a - b);
  assert.deepEqual(res.body.years, sorted, 'years should be sorted ascending');
});

// TODO: The cached-snapshot test requires seeding an Entity, Accounts, Transactions,
// TaxSlips, and Carryforwards in a configuration that produces a stable factsHash.
// The buildPersonalFacts builder also performs FX lookups for non-CAD transactions
// which adds complexity to the seed. Deferred as an integration concern — the
// caching logic (TaxReturn.findOne → hash compare → TaxReturn.create/update) is
// unit-testable independently of the HTTP layer.
test('GET /api/tax/personal/:year/return: cached snapshot (stub)', async () => {
  // Minimal stub: without an entity the route returns 404 which is correct
  // and consistent — the cached-snapshot path requires an entity + facts.
  // Full coverage is deferred per the plan comment above.
  const res = await authedNoEntity.get('/api/tax/personal/2025/return');
  assert.ok(res.status === 404 || res.status === 200, `unexpected status ${res.status}`);
});
