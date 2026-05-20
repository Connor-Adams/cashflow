/**
 * Integration tests run in isolation (`yarn test:integration`) so DATABASE_PATH
 * is set before any Sequelize import.
 *
 * The first registered user becomes superadmin (sees all households via
 * `isSuperadmin`); to exercise household scoping we seed two non-superadmin
 * users + households directly via the model layer and construct session
 * cookies that the supertest agents send on subsequent calls.
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
const dbPath = path.join(backendRoot, 'data', 'test-integration-settlements.sqlite');

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryContactId: number;

let otherAgent: ReturnType<typeof request.agent>;
let otherContactId: number;

type SeededHousehold = {
  token: string;
  contactId: number;
  householdId: number;
  userId: number;
};

async function seedHousehold(
  emailPrefix: string,
  contactName: string
): Promise<SeededHousehold> {
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
  const household = await models.Household.create({
    name: `${emailPrefix} household`,
  });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const contact = await models.Contact.create({
    householdId: household.id,
    name: contactName,
    notes: null,
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, contactId: contact.id, householdId: household.id, userId: user.id };
}

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      NODE_ENV: 'development',
    },
    stdio: 'pipe',
  });

  const mod = await import('../../src/app.js');
  app = mod.default;

  // Bootstrap a throwaway superadmin so subsequent registrations would require
  // an invite (we don't actually use this user for tests).
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seedHousehold('Primary', 'Sam Partner');
  primaryContactId = primary.contactId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seedHousehold('Other', 'Their Friend');
  otherContactId = other.contactId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
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

test('POST /api/settlements creates a settlement and joins contact name', async () => {
  const res = await primaryAgent.post('/api/settlements').send({
    contactId: primaryContactId,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 42.5,
    settledDate: '2026-05-20',
    notes: 'venmo',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.contactId, primaryContactId);
  assert.equal(res.body.contactName, 'Sam Partner');
  assert.equal(res.body.direction, 'i_paid_partner');
  assert.equal(res.body.currency, 'CAD');
  assert.equal(Number(res.body.amount), 42.5);
  assert.equal(res.body.settledDate, '2026-05-20');
});

test('POST /api/settlements rejects amount <= 0', async () => {
  const res = await primaryAgent.post('/api/settlements').send({
    contactId: primaryContactId,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 0,
    settledDate: '2026-05-20',
  });
  assert.equal(res.status, 400);
});

test('POST /api/settlements rejects invalid direction', async () => {
  const res = await primaryAgent.post('/api/settlements').send({
    contactId: primaryContactId,
    direction: 'i_split_with_partner',
    currency: 'CAD',
    amount: 5,
    settledDate: '2026-05-20',
  });
  assert.equal(res.status, 400);
});

test('POST /api/settlements rejects a contact outside the household', async () => {
  const res = await primaryAgent.post('/api/settlements').send({
    contactId: otherContactId,
    direction: 'partner_paid_me',
    currency: 'CAD',
    amount: 10,
    settledDate: '2026-05-20',
  });
  assert.equal(res.status, 400);
});

test('GET /api/settlements sorts newest settledDate first', async () => {
  const newer = await primaryAgent.post('/api/settlements').send({
    contactId: primaryContactId,
    direction: 'partner_paid_me',
    currency: 'CAD',
    amount: 12,
    settledDate: '2026-05-25',
  });
  assert.equal(newer.status, 201);

  const list = await primaryAgent.get('/api/settlements');
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ settledDate: string }>;
  assert.ok(rows.length >= 2);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].settledDate >= rows[i].settledDate);
  }
});

test('GET /api/settlements supports contactId and currency filters', async () => {
  const list = await primaryAgent
    .get('/api/settlements')
    .query({ contactId: primaryContactId, currency: 'CAD' });
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ contactId: number; currency: string }>;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.contactId, primaryContactId);
    assert.equal(row.currency, 'CAD');
  }
});

test('GET /api/settlements does not leak other households rows', async () => {
  const otherCreated = await otherAgent.post('/api/settlements').send({
    contactId: otherContactId,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 7,
    settledDate: '2026-05-30',
  });
  assert.equal(otherCreated.status, 201);

  const otherList = await otherAgent.get('/api/settlements');
  assert.equal(otherList.status, 200);
  const otherRows = otherList.body.data as Array<{ id: number }>;
  assert.equal(otherRows.length, 1);

  const primaryList = await primaryAgent.get('/api/settlements');
  const primaryIds = (primaryList.body.data as Array<{ id: number }>).map(
    (r) => r.id
  );
  assert.ok(!primaryIds.includes(otherCreated.body.id));
});

test('DELETE /api/settlements/:id only affects the owning household', async () => {
  const created = await primaryAgent.post('/api/settlements').send({
    contactId: primaryContactId,
    direction: 'i_paid_partner',
    currency: 'USD',
    amount: 9.99,
    settledDate: '2026-05-21',
  });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const wrongHousehold = await otherAgent.delete(`/api/settlements/${id}`);
  assert.equal(wrongHousehold.status, 404);

  const owner = await primaryAgent.delete(`/api/settlements/${id}`);
  assert.equal(owner.status, 204);

  const gone = await primaryAgent.delete(`/api/settlements/${id}`);
  assert.equal(gone.status, 404);
});
