/**
 * Integration tests for AI audit surface probes (#388-391).
 * Covers: health-deep, freshness, integrity, counts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let validToken: string;
let householdId: number;
let testDb: PgTestDb;

async function bootstrap(dbName: string) {
  testDb = await setupPgTestDb(dbName);
  process.env.DATABASE_URL = testDb.databaseUrl;
  app = (await import('../../src/app.js')).default;

  const models = await import('../../src/models/index.js');
  const { hashPassword } = await import('../../src/auth/password.js');
  const { mintAuditTokenPlaintext, hashAuditToken } = await import(
    '../../src/auth/auditToken.js'
  );
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `audit-probes-${Date.now()}@example.com`,
    displayName: 'probe-user',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'probe household' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  householdId = household.id;
  validToken = mintAuditTokenPlaintext();
  await models.UserAuditToken.create({
    userId: user.id,
    tokenHash: hashAuditToken(validToken),
    label: 'probe-token',
    lastUsedAt: null,
    revokedAt: null,
  });
}

before(async () => {
  await bootstrap('audit_probes');
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ── health-deep ──────────────────────────────────────────────────────────────

test('GET /api/audit/health-deep returns ok shape', async () => {
  const res = await request(app)
    .get('/api/audit/health-deep')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, 'cashflow-backend');
  assert.equal(typeof res.body.version, 'string');
  assert.equal(typeof res.body.uptimeSeconds, 'number');
  assert.equal(res.body.db.reachable, true);
  assert.equal(typeof res.body.db.latencyMs, 'number');
  assert.ok(res.body.db.latencyMs >= 0);
  assert.equal(res.body.migrations.pending, 0);
  assert.equal(typeof res.body.migrations.headName, 'string');
  assert.equal(typeof res.body.migrations.appliedCount, 'number');
  assert.ok(res.body.migrations.appliedCount > 0);
});

// ── freshness ────────────────────────────────────────────────────────────────

test('GET /api/audit/freshness returns jobs, imports, emailIntegrations', async () => {
  const models = await import('../../src/models/index.js');
  await models.Job.upsert({
    name: 'enrichment_backfill',
    lastRunAt: new Date(Date.now() - 60_000),
    lastFinishedAt: new Date(Date.now() - 30_000),
    lastStatus: 'ok',
    lastDurationMs: 30_000,
    lastError: null,
    lastResultJson: null,
    enabledOverride: null,
    cronOverride: null,
  });
  const res = await request(app)
    .get('/api/audit/freshness')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.jobs));
  const job = res.body.jobs.find((j: { name: string }) => j.name === 'enrichment_backfill');
  assert.ok(job, 'enrichment_backfill should appear in jobs list');
  assert.equal(job.lastStatus, 'ok');
  assert.ok(typeof job.secondsSinceLastRun === 'number');
  assert.ok(Array.isArray(res.body.imports));
  assert.ok(Array.isArray(res.body.emailIntegrations));
  assert.equal(typeof res.body.generatedAt, 'string');
});

// ── integrity ────────────────────────────────────────────────────────────────

test('GET /api/audit/integrity reports dupe groups and unenriched', async () => {
  const models = await import('../../src/models/index.js');
  const account = await models.Account.create({
    householdId,
    ownerUserId: null,
    owner: 'me',
    visibility: 'private',
    name: 'integrity-test-account',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: null,
  });
  const fingerprint = `fp-dupe-${Date.now()}`;
  const baseTxn = {
    accountId: account.id,
    householdId,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'integrity-test',
    date: '2026-01-01',
    merchantRaw: 'Dupe Merchant',
    merchantClean: 'Dupe Merchant',
    amount: '-10.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceIdentityFingerprint: fingerprint,
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
    autoBusiness: null,
    businessOverride: null,
    autoSplitType: null,
    splitOverride: null,
    autoPctMe: null,
    pctMeOverride: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    reviewFlag: false,
    reviewedAt: null,
    entityId: null,
  };
  // Two transactions with same fingerprint = 1 dupe group, 1 extra
  await models.Transaction.create({
    ...baseTxn,
    sourceRowFingerprint: `srfp-a-${Date.now()}`,
    merchantCanonical: 'some-merchant',
  });
  await models.Transaction.create({
    ...baseTxn,
    sourceRowFingerprint: `srfp-b-${Date.now()}`,
    merchantCanonical: null,
  });

  const res = await request(app)
    .get('/api/audit/integrity')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.duplicateGroups.count, 'number');
  assert.equal(typeof res.body.duplicateGroups.extraRowCount, 'number');
  assert.equal(typeof res.body.unenrichedTransactions, 'number');
  assert.equal(typeof res.body.orphanedTransactions, 'number');
  assert.ok(res.body.duplicateGroups.count >= 1);
  assert.ok(res.body.duplicateGroups.extraRowCount >= 1);
  assert.ok(res.body.unenrichedTransactions >= 1);
  assert.equal(res.body.orphanedTransactions, 0);
});

// ── counts ───────────────────────────────────────────────────────────────────

test('GET /api/audit/counts returns numbers for core models', async () => {
  const res = await request(app)
    .get('/api/audit/counts')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  for (const k of [
    'transactions',
    'accounts',
    'holdings',
    'rules',
    'contacts',
    'externalOrders',
    'subscriptions',
    'goals',
    'budgets',
    'auditLog',
    'chatThreads',
    'aiSuggestions',
  ]) {
    assert.equal(typeof res.body.counts[k], 'number', `missing count: ${k}`);
  }
  assert.equal(typeof res.body.generatedAt, 'string');
});
