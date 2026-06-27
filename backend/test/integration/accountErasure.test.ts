/**
 * Integration tests for the right-to-erasure endpoint (issue #850):
 *   DELETE /api/me/account
 *
 * Runs against real Postgres (so DB-level ON DELETE CASCADE behaves as it does
 * in production) and proves:
 *  - owner-gating (a non-owner member gets 403, nothing deleted),
 *  - the explicit-confirmation gate (wrong/missing confirm → 400, nothing deleted),
 *  - a successful erasure removes the household, every member user, all
 *    household-scoped financial data INCLUDING the no-FK tables that a naive
 *    delete would orphan (securities, audit_log, …), kills sessions, and sweeps
 *    on-disk vault + receipt files,
 *  - a second household is completely untouched (isolation).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import { testAgent } from './_setup/testServer.js';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('account_erasure');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // First-registered user becomes superadmin; needed so seedHousehold's
  // direct-write households are not the bootstrap user.
  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin-erasure@example.com',
    displayName: 'SuperE',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

function ownerAgent(token: string): ReturnType<typeof request.agent> {
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
  return agent;
}

test('403 when a non-owner member attempts erasure; nothing is deleted', async () => {
  const hh = await seedHousehold('NonOwner', 'Member HH');
  const models = await import('../../src/models');

  // Add a second, non-owner member with their own session.
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const pw = await hashPassword('password123');
  const member = await models.User.create({
    email: `member-${Date.now()}@example.com`,
    displayName: 'Member',
    globalRole: 'user',
    passwordHash: pw.hash,
    passwordSalt: pw.salt,
    passwordParams: pw.params,
  });
  await models.HouseholdMember.create({
    householdId: hh.householdId,
    userId: member.id,
    role: 'member',
  });
  const crypto = await import('node:crypto');
  const memberToken = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: member.id,
    tokenHash: hashToken(memberToken),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  });

  const res = await ownerAgent(memberToken)
    .delete('/api/me/account')
    .send({ confirm: 'Member HH' });
  assert.equal(res.status, 403);

  // Household and both users still exist.
  assert.ok(await models.Household.findByPk(hh.householdId));
  assert.ok(await models.User.findByPk(hh.userId));
  assert.ok(await models.User.findByPk(member.id));
});

test('400 when confirmation is missing or does not match the household name', async () => {
  const hh = await seedHousehold('BadConfirm', 'BadConfirm household');
  const models = await import('../../src/models');

  const missing = await ownerAgent(hh.token).delete('/api/me/account').send({});
  assert.equal(missing.status, 400);

  const wrong = await ownerAgent(hh.token)
    .delete('/api/me/account')
    .send({ confirm: 'not the name' });
  assert.equal(wrong.status, 400);

  // Still there.
  assert.ok(await models.Household.findByPk(hh.householdId));
});

test('owner erasure removes the household, users, no-FK rows, sessions, and files', async () => {
  const models = await import('../../src/models');
  const hh = await seedHousehold('Eraseme', 'Eraseme household');

  // Seed household-scoped data across several blast-radius tables, including
  // the no-FK ones (securities, audit_log) and file-bearing ones (vault).
  const account = await models.Account.create({
    householdId: hh.householdId,
    ownerUserId: hh.userId,
    name: 'Chequing',
    owner: 'me',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    visibility: 'private',
  } as never);
  const txn = await models.Transaction.create({
    householdId: hh.householdId,
    accountId: account.id,
    createdByUserId: hh.userId,
    importBatch: 'erase-test',
    date: '2026-01-01',
    merchantRaw: 'Coffee',
    merchantClean: 'Coffee',
    amount: '-5',
    currency: 'CAD',
    sourceRowFingerprint: `erase-row-${Date.now()}`,
    sourceIdentityFingerprint: `erase-id-${Date.now()}`,
    visibility: 'private',
  } as never);
  const security = await models.Security.create({
    householdId: hh.householdId,
    symbol: 'VFV',
    name: 'Vanguard',
    assetType: 'etf',
    currency: 'CAD',
  } as never);
  const auditRow = await models.AuditLog.create({
    householdId: hh.householdId,
    actorUserId: hh.userId,
    action: 'test.event',
    entityType: 'Test',
    entityId: 1,
  } as never);

  // Vault doc with an on-disk file. Write the file straight into the local
  // vault dir (test mode has no S3/encryption configured) so the row's
  // storedFilename points at a real file the sweep must delete.
  const { getVaultLocalDir } = await import('../../src/storage/vaultStorage.js');
  const { getReceiptsUploadDir } = await import('../../src/config/receipts.js');
  const vaultDir = getVaultLocalDir();
  const receiptsDir = getReceiptsUploadDir();
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(receiptsDir, { recursive: true });

  const vaultFilename = `erase-test-vault-${Date.now()}.txt`;
  const vaultPath = path.join(vaultDir, vaultFilename);
  await fs.writeFile(vaultPath, 'secret id doc');
  const vaultDoc = await models.VaultDocument.create({
    householdId: hh.householdId,
    uploadedByUserId: hh.userId,
    originalName: 'passport.txt',
    storedFilename: vaultFilename,
    mimeType: 'text/plain',
    sizeBytes: 13,
  } as never);

  // Receipt with an on-disk file, attached to the household's transaction.
  const receiptFilename = `erase-test-receipt-${Date.now()}.txt`;
  const receiptPath = path.join(receiptsDir, receiptFilename);
  await fs.writeFile(receiptPath, 'receipt bytes');
  const receipt = await models.Receipt.create({
    transactionId: txn.id,
    storedFilename: receiptFilename,
    originalName: 'receipt.txt',
    mimeType: 'text/plain',
    sizeBytes: 13,
  } as never);

  // Confirm the files exist on disk before erasure (local-FS test mode).
  assert.ok(await fileExists(vaultPath), 'vault file should exist before erasure');
  assert.ok(await fileExists(receiptPath), 'receipt file should exist before erasure');

  // A second household that must survive untouched.
  const survivor = await seedHousehold('Survivor', 'Survivor household');
  const survivorAccount = await models.Account.create({
    householdId: survivor.householdId,
    ownerUserId: survivor.userId,
    name: 'Survivor Chequing',
    owner: 'me',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    visibility: 'private',
  } as never);

  const res = await ownerAgent(hh.token)
    .delete('/api/me/account')
    .send({ confirm: 'Eraseme household' });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, true);
  assert.equal(res.body.householdId, hh.householdId);

  // Session cookie cleared.
  const setCookie = res.headers['set-cookie'];
  assert.ok(
    Array.isArray(setCookie) && setCookie.some((c) => /cashflow_session=;/.test(c)),
    'response should clear the session cookie',
  );

  // Household + user + every seeded row gone.
  assert.equal(await models.Household.findByPk(hh.householdId), null);
  assert.equal(await models.User.findByPk(hh.userId), null);
  assert.equal(await models.Account.findByPk(account.id), null);
  assert.equal(await models.Transaction.findByPk(txn.id), null);
  assert.equal(await models.Receipt.findByPk(receipt.id), null);
  assert.equal(await models.VaultDocument.findByPk(vaultDoc.id), null);
  // No-FK tables that a naive household delete would orphan:
  assert.equal(await models.Security.findByPk(security.id), null);
  assert.equal(await models.AuditLog.findByPk(auditRow.id), null);
  // Sessions dead.
  assert.equal(await models.Session.count({ where: { userId: hh.userId } }), 0);

  // On-disk files swept.
  assert.equal(await fileExists(vaultPath), false, 'vault file should be deleted');
  assert.equal(await fileExists(receiptPath), false, 'receipt file should be deleted');

  // Survivor household completely intact.
  assert.ok(await models.Household.findByPk(survivor.householdId));
  assert.ok(await models.User.findByPk(survivor.userId));
  assert.ok(await models.Account.findByPk(survivorAccount.id));
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
