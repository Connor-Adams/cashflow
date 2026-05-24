/**
 * Integration tests for /api/chat thread CRUD (PR2 Task 5).
 *
 * CHAT_ENABLED is set BEFORE importing src/app so the chat router actually
 * registers (the gate is read at module-load time).
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
const dbPath = path.join(backendRoot, 'data', 'test-integration-chat-threads.sqlite');

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let agent2: ReturnType<typeof request.agent>;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  // MUST be set before importing src/app — the chat router gate is read at module-load.
  process.env.CHAT_ENABLED = 'true';

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

  // Helper: build a fully-wired (User + Household + Session + cookie agent).
  async function makeAgent(label: string): Promise<ReturnType<typeof request.agent>> {
    const pw = await hashPassword('password123');
    const user = await models.User.create({
      email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      displayName: label,
      globalRole: 'user',
      passwordHash: pw.hash,
      passwordSalt: pw.salt,
      passwordParams: pw.params,
    });
    const household = await models.Household.create({ name: `${label} household` });
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
    const a = request.agent(app);
    a.jar.setCookie(`cashflow_session=${token}; Path=/`);
    return a;
  }

  agent = await makeAgent('Chat User 1');
  agent2 = await makeAgent('Chat User 2');
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

test('GET /api/chat/threads returns empty array initially', async () => {
  const res = await agent.get('/api/chat/threads');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('POST /api/chat/threads with title returns 201; GET lists it', async () => {
  const created = await agent
    .post('/api/chat/threads')
    .send({ title: 'Q4 cleanup' });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, 'Q4 cleanup');
  assert.equal(typeof created.body.id, 'number');
  assert.equal(created.body.archivedAt, null);

  const list = await agent.get('/api/chat/threads');
  assert.equal(list.status, 200);
  assert.ok(
    list.body.some(
      (t: { id: number; title: string | null }) =>
        t.id === created.body.id && t.title === 'Q4 cleanup'
    ),
    'list should contain newly-created thread'
  );
});

test('POST /api/chat/threads with no title returns 201 and title: null', async () => {
  const res = await agent.post('/api/chat/threads').send({});
  assert.equal(res.status, 201);
  assert.equal(res.body.title, null);
});

test('GET /api/chat/threads/:id returns { thread, messages: [], proposals: [] }', async () => {
  const created = await agent
    .post('/api/chat/threads')
    .send({ title: 'Detail view' });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const res = await agent.get(`/api/chat/threads/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.thread.id, id);
  assert.equal(res.body.thread.title, 'Detail view');
  assert.deepEqual(res.body.messages, []);
  assert.deepEqual(res.body.proposals, []);
});

test("GET /api/chat/threads/:id returns 404 for another user's thread", async () => {
  const created = await agent
    .post('/api/chat/threads')
    .send({ title: 'User1 private' });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const res = await agent2.get(`/api/chat/threads/${id}`);
  assert.equal(res.status, 404);
});

test("PATCH /api/chat/threads/:id returns 404 for another user's thread", async () => {
  const created = await agent
    .post('/api/chat/threads')
    .send({ title: 'user1 patch target' });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const res = await agent2
    .patch(`/api/chat/threads/${id}`)
    .send({ title: 'hacked' });
  assert.equal(res.status, 404);
});

test("DELETE /api/chat/threads/:id returns 404 for another user's thread", async () => {
  const created = await agent
    .post('/api/chat/threads')
    .send({ title: 'user1 delete target' });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const res = await agent2.delete(`/api/chat/threads/${id}`);
  assert.equal(res.status, 404);

  // Verify still exists for owner
  const own = await agent.get(`/api/chat/threads/${id}`);
  assert.equal(own.status, 200);
});

test('PATCH /api/chat/threads/:id with { title } renames; second GET reflects', async () => {
  const created = await agent.post('/api/chat/threads').send({ title: 'old name' });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const patched = await agent
    .patch(`/api/chat/threads/${id}`)
    .send({ title: 'renamed' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.title, 'renamed');

  const after2 = await agent.get(`/api/chat/threads/${id}`);
  assert.equal(after2.status, 200);
  assert.equal(after2.body.thread.title, 'renamed');
});

test('PATCH /api/chat/threads/:id with { archived: true } hides from list', async () => {
  const created = await agent
    .post('/api/chat/threads')
    .send({ title: 'archive me' });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const patched = await agent
    .patch(`/api/chat/threads/${id}`)
    .send({ archived: true });
  assert.equal(patched.status, 200);
  assert.ok(patched.body.archivedAt, 'archivedAt should be set');

  const list = await agent.get('/api/chat/threads');
  assert.equal(list.status, 200);
  assert.ok(
    !list.body.some((t: { id: number }) => t.id === id),
    'archived thread must not appear in list'
  );
});

test('PATCH /api/chat/threads/:id with { archived: false } clears archivedAt', async () => {
  const created = await agent
    .post('/api/chat/threads')
    .send({ title: 'archive then restore' });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const arch = await agent
    .patch(`/api/chat/threads/${id}`)
    .send({ archived: true });
  assert.equal(arch.status, 200);
  assert.ok(arch.body.archivedAt);

  const restored = await agent
    .patch(`/api/chat/threads/${id}`)
    .send({ archived: false });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.archivedAt, null);

  const list = await agent.get('/api/chat/threads');
  assert.ok(
    list.body.some((t: { id: number }) => t.id === id),
    'unarchived thread should reappear in list'
  );
});

test('DELETE /api/chat/threads/:id returns 204; subsequent GET is 404', async () => {
  const created = await agent
    .post('/api/chat/threads')
    .send({ title: 'delete me' });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const del = await agent.delete(`/api/chat/threads/${id}`);
  assert.equal(del.status, 204);

  const res = await agent.get(`/api/chat/threads/${id}`);
  assert.equal(res.status, 404);
});
