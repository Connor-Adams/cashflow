/**
 * Integration test: GET /api/ai/status reports both `openai` and `chat` flags.
 * `chat` is always-on whenever OPENAI_API_KEY is set — the feature flag was
 * removed in favour of always-on chat (the only reason chat would be
 * unavailable is no provider, which `openai=false` already conveys).
 *
 * `getOpenAiConfig` reads process.env on each call, so we can flip env vars
 * between assertions in a single test run without re-importing the app.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

// Snapshot the env vars we mutate so we can restore them in `after`.
const ENV_KEYS = ['OPENAI_API_KEY'] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

before(async () => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

  // Start clean — flags get set per-test below.
  delete process.env.OPENAI_API_KEY;

  testDb = await setupPgTestDb('ai-status-chat');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // First-registered user becomes superadmin; we don't use that agent.
  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const pw = await hashPassword('password123');
  const user = await models.User.create({
    email: `ai-status-${Date.now()}@example.com`,
    displayName: 'AI Status User',
    globalRole: 'user',
    passwordHash: pw.hash,
    passwordSalt: pw.salt,
    passwordParams: pw.params,
  });
  const household = await models.Household.create({ name: 'household' });
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

after(async () => {
  // Restore env to whatever it was at file-load time.
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  await teardownPgTestDb(testDb);
});

test('GET /api/ai/status without OPENAI_API_KEY: openai=false, chat=false', async () => {
  delete process.env.OPENAI_API_KEY;
  const res = await agent.get('/api/ai/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { openai: false, chat: false });
});

test('GET /api/ai/status with OPENAI_API_KEY: openai=true, chat=true (chat is always-on)', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  const res = await agent.get('/api/ai/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { openai: true, chat: true });
});
