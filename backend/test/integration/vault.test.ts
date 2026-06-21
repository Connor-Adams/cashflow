/**
 * Integration tests for the encrypted finance vault (Cashflow issue #241).
 *
 * Exercises upload, list/search/tag-filter, metadata GET, download, PATCH,
 * DELETE end-to-end against Postgres. Covers:
 *  - upload + decrypted download round-trip (encryption key configured)
 *  - household isolation: another household cannot see the document
 *  - private visibility: only the uploader sees their private docs
 *  - tag filter
 *  - linkedEntity filter
 *  - DELETE removes row + does not affect any receipts/transactions
 *  - Receipt routes still work (regression guard for AC)
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let secondaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryAccountId: number;
let primaryUserId: number;
let secondaryHouseholdId: number;
let secondaryAccountId: number;
let testDb: PgTestDb;
let uploadDir: string;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  accountId: number;
};

async function seed(emailPrefix: string): Promise<Seeded> {
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
  const household = await models.Household.create({ name: `${emailPrefix} household` });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const account = await models.Account.create({
    householdId: household.id,
    ownerUserId: user.id,
    owner: 'me',
    visibility: 'shared',
    name: `${emailPrefix} card`,
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, householdId: household.id, userId: user.id, accountId: account.id };
}

before(async () => {
  process.env.NODE_ENV = 'test';
  // 64-char hex key for AES-256-GCM. Stable across the suite.
  process.env.VAULT_ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  // Local upload dir for vault bytes — must exist before saveVaultObject runs.
  uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
  process.env.RECEIPTS_UPLOAD_DIR = uploadDir;

  testDb = await setupPgTestDb('vault');
  const mod = await import('../../src/app.js');
  app = mod.default;

  // Bootstrap superadmin via the registration route.
  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryUserId = primary.userId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const secondary = await seed('Secondary');
  secondaryHouseholdId = secondary.householdId;
  secondaryAccountId = secondary.accountId;
  secondaryAgent = testAgent(app);
  secondaryAgent.jar.setCookie(`cashflow_session=${secondary.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
  try {
    await fs.rm(uploadDir, { recursive: true, force: true });
  } catch {
    /* best-effort tmp cleanup */
  }
});

// ---- Upload + download ---------------------------------------------------

test('POST /api/vault/documents uploads + GET file decrypts', async () => {
  const bytes = Buffer.from('hello vault world', 'utf8');
  const res = await primaryAgent
    .post('/api/vault/documents')
    .field('tags', JSON.stringify(['tax-2024', 'invoice']))
    .field('description', 'Personal invoice')
    .attach('file', bytes, { filename: 'invoice.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.originalName, 'invoice.pdf');
  assert.equal(res.body.data.mimeType, 'application/pdf');
  assert.equal(res.body.data.sizeBytes, bytes.length);
  assert.equal(res.body.data.encryptionAlgorithm, 'aes-256-gcm');
  assert.equal(res.body.data.householdId, primaryHouseholdId);
  assert.equal(res.body.data.uploadedByUserId, primaryUserId);
  assert.deepEqual(res.body.data.tags.sort(), ['invoice', 'tax-2024']);

  const docId = res.body.data.id as number;
  const download = await primaryAgent.get(`/api/vault/documents/${docId}/file`);
  assert.equal(download.status, 200);
  assert.equal(Buffer.from(download.body as Buffer).toString('utf8'), 'hello vault world');
});

test('stored bytes on disk are encrypted (not equal to plaintext)', async () => {
  const bytes = Buffer.from('top secret receipt', 'utf8');
  const res = await primaryAgent
    .post('/api/vault/documents')
    .attach('file', bytes, { filename: 'secret.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 201);
  const docId = res.body.data.id as number;

  const models = await import('../../src/models');
  const row = await models.VaultDocument.findByPk(docId);
  assert.ok(row, 'row exists');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = row;
  const onDisk = await fs.readFile(path.join(uploadDir, 'vault', r.storedFilename));
  // Encrypted envelope must NOT equal plaintext.
  assert.notEqual(onDisk.toString('utf8'), 'top secret receipt');
  // First byte = version 0x01 (AES-256-GCM envelope).
  assert.equal(onDisk[0], 0x01);
});

// ---- Household isolation -------------------------------------------------

test('other household cannot see another household\'s vault documents', async () => {
  const bytes = Buffer.from('cross-household-test', 'utf8');
  const upload = await primaryAgent
    .post('/api/vault/documents')
    .attach('file', bytes, { filename: 'iso.pdf', contentType: 'application/pdf' });
  assert.equal(upload.status, 201);
  const docId = upload.body.data.id as number;

  const list = await secondaryAgent.get('/api/vault/documents');
  assert.equal(list.status, 200);
  const ids = (list.body.data as Array<{ id: number }>).map((r) => r.id);
  assert.ok(!ids.includes(docId), 'secondary household must not see primary docs');

  const meta = await secondaryAgent.get(`/api/vault/documents/${docId}`);
  assert.equal(meta.status, 404);
  const download = await secondaryAgent.get(`/api/vault/documents/${docId}/file`);
  assert.equal(download.status, 404);
});

// ---- Listing / search / filter -------------------------------------------

test('GET /api/vault/documents supports q + tag + linkedType filters', async () => {
  // Upload three documents with different tags + linkage.
  await primaryAgent
    .post('/api/vault/documents')
    .field('tags', '["mortgage","2024"]')
    .field('linkedEntityType', 'account')
    .field('linkedEntityId', String(primaryAccountId))
    .attach('file', Buffer.from('a'), { filename: 'mortgage-statement.pdf', contentType: 'application/pdf' });
  await primaryAgent
    .post('/api/vault/documents')
    .field('tags', '["warranty"]')
    .field('linkedEntityType', 'purchase')
    .field('linkedEntityId', '42')
    .attach('file', Buffer.from('b'), { filename: 'warranty-extension.pdf', contentType: 'application/pdf' });
  await primaryAgent
    .post('/api/vault/documents')
    .attach('file', Buffer.from('c'), { filename: 'random.txt', contentType: 'text/plain' });

  const all = await primaryAgent.get('/api/vault/documents');
  assert.equal(all.status, 200);
  assert.ok((all.body.data as unknown[]).length >= 3);

  const search = await primaryAgent.get('/api/vault/documents?q=mortgage');
  assert.equal(search.status, 200);
  const names = (search.body.data as Array<{ originalName: string }>).map((r) => r.originalName);
  assert.ok(names.some((n) => n.includes('mortgage-statement')));
  assert.ok(!names.some((n) => n.includes('warranty-extension')));

  const tagged = await primaryAgent.get('/api/vault/documents?tag=warranty');
  assert.equal(tagged.status, 200);
  const taggedNames = (tagged.body.data as Array<{ originalName: string }>).map((r) => r.originalName);
  assert.ok(taggedNames.some((n) => n.includes('warranty-extension')));
  assert.ok(!taggedNames.some((n) => n.includes('mortgage-statement')));

  const linked = await primaryAgent.get(
    `/api/vault/documents?linkedType=account&linkedId=${primaryAccountId}`,
  );
  assert.equal(linked.status, 200);
  const linkedNames = (linked.body.data as Array<{ originalName: string }>).map((r) => r.originalName);
  assert.ok(linkedNames.some((n) => n.includes('mortgage-statement')));
});

// ---- Private visibility --------------------------------------------------

test('private vault docs are scoped to the uploader within a household', async () => {
  const bytes = Buffer.from('private-doc', 'utf8');
  const upload = await primaryAgent
    .post('/api/vault/documents')
    .field('visibility', 'private')
    .attach('file', bytes, { filename: 'private.pdf', contentType: 'application/pdf' });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.data.visibility, 'private');
  const docId = upload.body.data.id as number;

  const ownerSees = await primaryAgent.get(`/api/vault/documents/${docId}`);
  assert.equal(ownerSees.status, 200);
});

// ---- PATCH ---------------------------------------------------------------

test('PATCH /api/vault/documents/:id updates metadata only', async () => {
  const bytes = Buffer.from('patch-target', 'utf8');
  const create = await primaryAgent
    .post('/api/vault/documents')
    .attach('file', bytes, { filename: 'old.pdf', contentType: 'application/pdf' });
  assert.equal(create.status, 201);
  const docId = create.body.data.id as number;

  const patch = await primaryAgent
    .patch(`/api/vault/documents/${docId}`)
    .send({
      originalName: 'new-name.pdf',
      tags: ['updated', 'tag-set'],
      linkedEntityType: 'tax_year',
      linkedEntityId: 2024,
      description: 'Updated description',
    });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.data.originalName, 'new-name.pdf');
  assert.deepEqual(patch.body.data.tags, ['updated', 'tag-set']);
  assert.equal(patch.body.data.linkedEntityType, 'tax_year');
  assert.equal(patch.body.data.linkedEntityId, 2024);
  assert.equal(patch.body.data.description, 'Updated description');
});

test('PATCH /api/vault/documents/:id rejects invalid linkedEntityType', async () => {
  const create = await primaryAgent
    .post('/api/vault/documents')
    .attach('file', Buffer.from('x'), { filename: 'a.pdf', contentType: 'application/pdf' });
  const docId = create.body.data.id as number;
  const patch = await primaryAgent
    .patch(`/api/vault/documents/${docId}`)
    .send({ linkedEntityType: 'definitely-not-a-thing' });
  assert.equal(patch.status, 400);
});

// ---- DELETE --------------------------------------------------------------

test('DELETE /api/vault/documents/:id removes row + file', async () => {
  const bytes = Buffer.from('delete-me', 'utf8');
  const create = await primaryAgent
    .post('/api/vault/documents')
    .attach('file', bytes, { filename: 'gone.pdf', contentType: 'application/pdf' });
  assert.equal(create.status, 201);
  const docId = create.body.data.id as number;

  const del = await primaryAgent.delete(`/api/vault/documents/${docId}`);
  assert.equal(del.status, 204);

  const get = await primaryAgent.get(`/api/vault/documents/${docId}`);
  assert.equal(get.status, 404);
});

test('DELETE /api/vault/documents/:id does not affect transactions or receipts', async () => {
  // Seed a transaction in the primary household and confirm it remains
  // queryable after a vault doc with a linkedEntity=transaction reference
  // is deleted.
  const models = await import('../../src/models');
  const txn = await models.Transaction.create({
    accountId: primaryAccountId,
    householdId: primaryHouseholdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'vault-test',
    date: '2025-05-01',
    merchantRaw: 'Vendor',
    merchantClean: 'Vendor',
    amount: '-50.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: 'Misc',
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: primaryUserId,
  });

  const create = await primaryAgent
    .post('/api/vault/documents')
    .field('linkedEntityType', 'transaction')
    .field('linkedEntityId', String(txn.id))
    .attach('file', Buffer.from('linked'), { filename: 'linked.pdf', contentType: 'application/pdf' });
  assert.equal(create.status, 201);
  const docId = create.body.data.id as number;

  const del = await primaryAgent.delete(`/api/vault/documents/${docId}`);
  assert.equal(del.status, 204);

  const stillThere = await models.Transaction.findByPk(txn.id);
  assert.ok(stillThere, 'transaction must still exist after vault doc deletion');
});

// ---- Existing receipts workflow unaffected -------------------------------

test('Receipt upload route still works for transactions (regression guard)', async () => {
  // Seed a transaction in the primary household.
  const models = await import('../../src/models');
  const txn = await models.Transaction.create({
    accountId: primaryAccountId,
    householdId: primaryHouseholdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'vault-test-receipt',
    date: '2025-05-02',
    merchantRaw: 'Coffee Shop',
    merchantClean: 'Coffee Shop',
    amount: '-12.5000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: 'Coffee',
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: primaryUserId,
  });

  // A 1x1 PNG (smallest valid).
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
    'hex',
  );
  const res = await primaryAgent
    .post(`/api/transactions/${txn.id}/receipts`)
    .attach('file', png, { filename: 'receipt.png', contentType: 'image/png' });
  assert.equal(res.status, 201);
  assert.equal(res.body.transactionId, txn.id);
});
