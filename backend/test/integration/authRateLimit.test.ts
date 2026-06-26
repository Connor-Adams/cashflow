/**
 * Integration test for issue #833 — the /api/auth limiters are actually wired
 * onto the login/register routes (the unit test in
 * src/routes/authRateLimit.test.ts proves the limiter logic; this proves the
 * route plumbing). Forces the limiter on via AUTH_RATE_LIMIT_FORCE (limiters
 * otherwise skip in NODE_ENV==='test') and resets buckets before each block so
 * the shared module-global state is deterministic.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { testAgent } from './_setup/testServer.js';
import type { Express } from 'express';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: Express;
let testDb: PgTestDb;
let resetAuthRateLimit: () => void;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.AUTH_RATE_LIMIT_FORCE = '1';
  process.env.AUTH_LOGIN_RATE_LIMIT_MAX = '5';
  process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '5';

  testDb = await setupPgTestDb('auth_rate_limit');
  app = (await import('../../src/app.js')).default;
  ({ __resetAuthRateLimitForTest: resetAuthRateLimit } = await import(
    '../../src/routes/authRateLimit.js'
  ));

  // Bootstrap one real user so login can succeed below the threshold.
  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'ratelimit-user@example.com',
    displayName: 'RL',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  delete process.env.AUTH_RATE_LIMIT_FORCE;
  delete process.env.AUTH_LOGIN_RATE_LIMIT_MAX;
  delete process.env.AUTH_REGISTER_RATE_LIMIT_MAX;
  await teardownPgTestDb(testDb);
});

test('repeated failed logins past the threshold return 429', async () => {
  resetAuthRateLimit();
  const agent = testAgent(app);
  // 5 allowed attempts (all wrong password -> 401), 6th -> 429.
  for (let i = 0; i < 5; i++) {
    const res = await agent
      .post('/api/auth/login')
      .send({ email: 'ratelimit-user@example.com', password: 'wrong-password' });
    assert.equal(res.status, 401, `attempt ${i + 1} should be 401, not rate-limited yet`);
  }
  const blocked = await agent
    .post('/api/auth/login')
    .send({ email: 'ratelimit-user@example.com', password: 'wrong-password' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'auth_rate_limit');
});

test('login limiter is keyed by email — a different email is not blocked', async () => {
  resetAuthRateLimit();
  const agent = testAgent(app);
  for (let i = 0; i < 6; i++) {
    await agent
      .post('/api/auth/login')
      .send({ email: 'victim@example.com', password: 'x' });
  }
  // Same IP, different (legitimate) email must still reach the handler (401,
  // not 429) — an attacker guessing one email can't lock out another account.
  const other = await agent
    .post('/api/auth/login')
    .send({ email: 'ratelimit-user@example.com', password: 'wrong-password' });
  assert.equal(other.status, 401);
});

test('repeated registrations past the threshold return 429', async () => {
  resetAuthRateLimit();
  const agent = testAgent(app);
  for (let i = 0; i < 5; i++) {
    const res = await agent.post('/api/auth/register').send({
      email: `bulk-${i}@example.com`,
      displayName: `Bulk ${i}`,
      password: 'password123',
    });
    assert.equal(res.status, 201, `register ${i + 1} should succeed`);
  }
  const blocked = await agent.post('/api/auth/register').send({
    email: 'bulk-over@example.com',
    displayName: 'Over',
    password: 'password123',
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'auth_rate_limit');
});
