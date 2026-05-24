/**
 * Integration test (PR2 Task 15): GET /api/ai/status reports both `openai`
 * and `chat` flags. `chat` is true only when BOTH OPENAI_API_KEY is set AND
 * CHAT_ENABLED=true.
 *
 * Both `getOpenAiConfig` and `getChatConfig` read process.env on each call,
 * so we can flip env vars between assertions in a single test run without
 * re-importing the app. The `/api/ai/status` endpoint sits on the always-
 * mounted `ai` router, so the `CHAT_ENABLED` import-time gate on the chat
 * router itself is not relevant here.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-integration-ai-status-chat.sqlite');

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;

// Snapshot the env vars we mutate so we can restore them in `after`.
const ENV_KEYS = ['OPENAI_API_KEY', 'CHAT_ENABLED'] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

before(async () => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  // Start clean — flags get set per-test below.
  delete process.env.OPENAI_API_KEY;
  delete process.env.CHAT_ENABLED;

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const mod = await import('../../src/app.js');
  app = mod.default;

  // First-registered user becomes superadmin; we don't use that agent.
  const bootstrap = request.agent(app);
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
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(() => {
  // Restore env to whatever it was at file-load time.
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

test('GET /api/ai/status with neither flag set: openai=false, chat=false', async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CHAT_ENABLED;
  const res = await agent.get('/api/ai/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { openai: false, chat: false });
});

test('GET /api/ai/status with only OPENAI_API_KEY: openai=true, chat=false', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  delete process.env.CHAT_ENABLED;
  const res = await agent.get('/api/ai/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { openai: true, chat: false });
});

test('GET /api/ai/status with only CHAT_ENABLED: openai=false, chat=false', async () => {
  // chat must require BOTH flags — CHAT_ENABLED alone is not enough.
  delete process.env.OPENAI_API_KEY;
  process.env.CHAT_ENABLED = 'true';
  const res = await agent.get('/api/ai/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { openai: false, chat: false });
});

test('GET /api/ai/status with both flags set: openai=true, chat=true', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  process.env.CHAT_ENABLED = 'true';
  const res = await agent.get('/api/ai/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { openai: true, chat: true });
});
