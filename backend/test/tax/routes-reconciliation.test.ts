/**
 * Integration tests for GET /api/tax/personal/:year/reconciliation (Task 11, P6).
 *
 * Uses `sequelize.sync({force: true})` rather than running migrations because
 * one of the recent migrations (20260527130000-widen-investment-quantity) uses
 * Postgres-specific ALTER COLUMN syntax that SQLite cannot parse. The sync
 * path mirrors the convention used by backend/test/tax/reconciliation/*.test.ts
 * (e.g. buildReport.test.ts).
 *
 * Auth note: app.ts mounts `requireAuth` at `app.use('/api', requireAuth)` so
 * every /api/tax/* endpoint is protected at the global level — unauthenticated
 * requests get 401 before they ever reach the tax router.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authedWithEntity: ReturnType<typeof request.agent>;
let authedNoEntity: ReturnType<typeof request.agent>;
let entityId: number;

before(async () => {
  process.env.NODE_ENV = 'test';

  const { sequelize } = await import('../../src/db.js');
  // Import models BEFORE sync so all model tables are registered and created.
  const models = await import('../../src/models/index.js');
  await sequelize.sync({ force: true });

  const mod = await import('../../src/app.js');
  app = mod.default;

  const { hashPassword, hashToken } = await import('../../src/auth/password.js');

  // ---------- Household #1: has personal entity + a reportable txn ----------
  {
    const password = await hashPassword('password123');
    const user = await models.User.create({
      email: `tax-recon-with-${Date.now()}@example.com`,
      displayName: 'Recon Test (with entity)',
      globalRole: 'user',
      passwordHash: password.hash,
      passwordSalt: password.salt,
      passwordParams: password.params,
    });
    const household = await models.Household.create({ name: 'Recon Test HH' });
    await models.HouseholdMember.create({
      householdId: household.id,
      userId: user.id,
      role: 'owner',
    });

    const entity = await models.Entity.create({
      householdId: household.id,
      kind: 'personal',
      legalName: 'P',
      jurisdiction: 'CA-ON',
      fiscalYearEnd: null,
    });
    entityId = entity.id;

    const account = await models.Account.create({
      name: 'Chk',
      householdId: household.id,
      accountType: 'checking',
      entityId: entity.id,
      taxStatus: 'non_registered',
      defaultCurrency: 'CAD',
    } as never);

    // Employment income txn with no T4 slip → triggers missing_slip (and
    // slip_divergence since $5000 > $50 threshold).
    await models.Transaction.create({
      accountId: account.id,
      householdId: household.id,
      entityId: entity.id,
      date: '2024-03-15',
      amount: '5000',
      currency: 'CAD',
      finalCategory: 'employment_income',
      merchantRaw: 'E',
      merchantClean: 'E',
      importBatch: 'b',
      sourceRowFingerprint: 'fp1',
      sourceIdentityFingerprint: 'sif1',
    } as never);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
    await models.Session.create({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
    });

    authedWithEntity = request.agent(app);
    authedWithEntity.jar.setCookie(`cashflow_session=${token}; Path=/`);
  }

  // ---------- Household #2: no personal entity (for the 404 case) ----------
  {
    const password = await hashPassword('password123');
    const user = await models.User.create({
      email: `tax-recon-none-${Date.now()}@example.com`,
      displayName: 'Recon Test (no entity)',
      globalRole: 'user',
      passwordHash: password.hash,
      passwordSalt: password.salt,
      passwordParams: password.params,
    });
    const household = await models.Household.create({ name: 'Recon Test HH (no entity)' });
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
  }
});

after(async () => {
  const { sequelize } = await import('../../src/db.js');
  await sequelize.close();
});

test('GET /api/tax/personal/:year/reconciliation without auth returns 401', async () => {
  const res = await request(app).get('/api/tax/personal/2024/reconciliation');
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('GET /api/tax/personal/:year/reconciliation returns report shape', async () => {
  const res = await authedWithEntity.get('/api/tax/personal/2024/reconciliation');
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.entityId, entityId);
  assert.equal(res.body.year, 2024);
  assert.equal(res.body.counts.missing_slip, 1);
  // A $5000 employment txn with no T4 slip also triggers slip_divergence
  // ($5000 > $50 threshold), so findings.length should be at least 2.
  assert.ok(Array.isArray(res.body.findings));
  assert.ok(res.body.findings.length >= 1);
  assert.ok(typeof res.body.generatedAt === 'string');
});

test('GET /api/tax/personal/:year/reconciliation returns 404 when no personal entity exists', async () => {
  const res = await authedNoEntity.get('/api/tax/personal/2024/reconciliation');
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'no_personal_entity');
});

test('GET /api/tax/personal/invalid/reconciliation returns 400', async () => {
  const res = await authedWithEntity.get('/api/tax/personal/invalid/reconciliation');
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'invalid_year');
});
