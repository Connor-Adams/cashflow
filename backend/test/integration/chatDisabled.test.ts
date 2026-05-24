/**
 * Integration test (PR2 Task 5): with CHAT_ENABLED unset, /api/chat/* routes
 * must 404 — the router is gated at app-import time so it never registers.
 *
 * Lives in its own file so the env-var precondition (CHAT_ENABLED MUST be
 * unset before `await import('../../src/app.js')`) can't be contaminated by
 * other tests in the same process.
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
const dbPath = path.join(backendRoot, 'data', 'test-integration-chat-disabled.sqlite');

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  // Explicitly ensure CHAT_ENABLED is NOT 'true' before importing src/app.
  delete process.env.CHAT_ENABLED;

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const mod = await import('../../src/app.js');
  app = mod.default;

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
    email: `chat-disabled-${Date.now()}@example.com`,
    displayName: 'Chat Disabled User',
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
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

test('GET /api/chat/threads 404s when CHAT_ENABLED unset', async () => {
  const res = await agent.get('/api/chat/threads');
  assert.equal(res.status, 404);
});

test('POST /api/chat/threads 404s when CHAT_ENABLED unset', async () => {
  const res = await agent.post('/api/chat/threads').send({ title: 'x' });
  assert.equal(res.status, 404);
});
