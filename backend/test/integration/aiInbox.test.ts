/**
 * Integration tests for /api/ai/inbox*. Runs in isolation (`yarn test:integration`)
 * so DATABASE_PATH is set before any Sequelize import.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-integration-ai-inbox.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let regularAgent: ReturnType<typeof request.agent>;
let householdId: number;
let otherHouseholdId: number;

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
  authed = request.agent(app);
  // First registered user becomes superadmin.
  const register = await authed.post('/api/auth/register').send({
    email: 'inbox@example.com',
    displayName: 'Inbox User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  householdId = register.body.user.householdId as number;

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

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
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
