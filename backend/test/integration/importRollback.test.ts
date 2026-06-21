/**
 * Integration tests for the import rollback flow (#233).
 *
 * Boots an isolated Postgres DB, registers an integration user, uploads a CSV
 * to create an import batch, then exercises the two rollback endpoints:
 *  - GET  /api/import/history/:batchLabel/rollback-preview
 *  - POST /api/import/history/:batchLabel/rollback
 *
 * Covered scenarios mirror the issue's AC bullets:
 *  - happy-path: a clean batch rolls back, transactions disappear, the
 *    ImportHistory row is marked `rolled_back`
 *  - preview-only: counts + sample populated, blockers empty
 *  - block: an in-batch transaction with a transfer link to another batch
 *    surfaces a `cross_batch_link` blocker and the rollback POST returns 409
 *  - manual-transaction preservation: a hand-created transaction outside the
 *    batch survives a rollback that targets only the imported batch
 *  - second rollback is rejected as `already_rolled_back`
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let models: typeof import('../../src/models/index.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const csvUploadDir = path.join(backendRoot, 'uploads', 'test-integration-rollback-csv');

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

before(async () => {
  fs.mkdirSync(csvUploadDir, { recursive: true });
  process.env.CSV_UPLOAD_DIR = csvUploadDir;

  testDb = await setupPgTestDb('rollback');

  models = await import('../../src/models/index.js');
  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'rollback@example.com',
    displayName: 'Rollback User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function uploadBatch(opts: {
  accountId: number;
  batchLabel: string;
  csv: string;
  fileName: string;
}): Promise<void> {
  const res = await authed
    .post('/api/import/upload')
    .field('accountId', String(opts.accountId))
    .field('profileId', 'generic_simple')
    .field('batchLabel', opts.batchLabel)
    .attach('file', Buffer.from(opts.csv, 'utf8'), {
      filename: opts.fileName,
      contentType: 'text/csv',
    });
  assert.equal(res.status, 200);
}

test('rollback preview surfaces affected counts and sample', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Preview Acct',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  await uploadBatch({
    accountId,
    batchLabel: 'preview-batch-1',
    csv: 'Date,Description,Amount\n2025-06-01,Preview Cafe,-5.50\n2025-06-02,Preview Shop,-3.00\n',
    fileName: 'preview1.csv',
  });

  const res = await authed.get(
    `/api/import/history/${encodeURIComponent('preview-batch-1')}/rollback-preview`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.batchLabel, 'preview-batch-1');
  assert.equal(res.body.canRollback, true);
  assert.ok(Array.isArray(res.body.blockers));
  assert.equal(res.body.blockers.length, 0);
  assert.equal(res.body.transactionCount, 2);
  assert.ok(res.body.sample.length === 2);
  assert.ok(res.body.dependentCounts);
  assert.equal(res.body.dependentCounts.receipts, 0);
});

test('rollback preview returns not_found for an unknown batch', async () => {
  const res = await authed.get(
    `/api/import/history/${encodeURIComponent('does-not-exist')}/rollback-preview`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.canRollback, false);
  assert.ok(res.body.blockers.length >= 1);
  assert.equal(res.body.blockers[0].code, 'not_found');
});

test('rollback POST deletes the batch and preserves manual transactions', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Rollback Acct',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  await uploadBatch({
    accountId,
    batchLabel: 'rollback-batch-1',
    csv: 'Date,Description,Amount\n2025-06-01,Roll One,-5.50\n2025-06-02,Roll Two,-3.00\n',
    fileName: 'rollback1.csv',
  });

  // Seed a manual transaction in the same account but OUTSIDE the batch.
  // We use direct model insertion so we don't depend on a /transactions
  // POST route.
  const me = await authed.get('/api/auth/me');
  assert.equal(me.status, 200);
  const userId = me.body.user.id as number;
  const householdId = me.body.user.household.id as number;
  const manual = await models.Transaction.create({
    accountId,
    householdId,
    createdByUserId: userId,
    visibility: 'shared',
    importBatch: 'manual',
    date: '2025-06-05',
    merchantRaw: 'Manual Survivor',
    merchantClean: 'Manual Survivor',
    amount: '-1.00',
    currency: 'CAD',
    sourceRowFingerprint: 'manual-fp-1',
    sourceIdentityFingerprint: 'manual-id-1',
    reviewFlag: false,
  });

  const res = await authed.post(
    `/api/import/history/${encodeURIComponent('rollback-batch-1')}/rollback`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.batchLabel, 'rollback-batch-1');
  assert.equal(res.body.deletedTransactions, 2);

  // The manual transaction must survive.
  const survivor = await models.Transaction.findByPk(manual.id);
  assert.ok(survivor, 'manual transaction should survive rollback');
  assert.equal(survivor?.merchantClean, 'Manual Survivor');

  // The imported transactions must be gone.
  const remaining = await models.Transaction.count({
    where: { importBatch: 'rollback-batch-1' },
  });
  assert.equal(remaining, 0);

  // The ImportHistory row must be marked rolled_back with the actor stamped.
  const history = await models.ImportHistory.findOne({
    where: { batchLabel: 'rollback-batch-1' },
  });
  assert.ok(history, 'ImportHistory row should still exist');
  assert.equal(history?.status, 'rolled_back');
  assert.ok(history?.rolledBackAt, 'rolledBackAt should be stamped');
  assert.equal(history?.rolledBackByUserId, userId);
});

test('second rollback returns 409 already_rolled_back', async () => {
  const res = await authed.post(
    `/api/import/history/${encodeURIComponent('rollback-batch-1')}/rollback`,
  );
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'rollback_blocked');
  assert.ok(
    res.body.blockers.some((b: { code: string }) => b.code === 'already_rolled_back'),
    `expected already_rolled_back blocker, got: ${JSON.stringify(res.body.blockers)}`,
  );
});

test('rollback blocked when a transaction is linked to another batch', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Blocked Acct',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  // Upload two batches; we'll wire a cross-batch transfer link by hand to
  // simulate the "user marked a refund/transfer across batches" workflow.
  await uploadBatch({
    accountId,
    batchLabel: 'cross-batch-source',
    csv: 'Date,Description,Amount\n2025-07-01,Source Txn,-10.00\n',
    fileName: 'src.csv',
  });
  await uploadBatch({
    accountId,
    batchLabel: 'cross-batch-target',
    csv: 'Date,Description,Amount\n2025-07-02,Target Txn,10.00\n',
    fileName: 'tgt.csv',
  });

  const [src] = await models.Transaction.findAll({
    where: { importBatch: 'cross-batch-source' },
  });
  const [tgt] = await models.Transaction.findAll({
    where: { importBatch: 'cross-batch-target' },
  });
  assert.ok(src && tgt, 'both seed transactions should exist');
  src.linkedTransactionId = tgt.id;
  src.transferPurpose = 'transfer';
  src.transferLinkedAt = new Date();
  await src.save();

  const preview = await authed.get(
    `/api/import/history/${encodeURIComponent('cross-batch-source')}/rollback-preview`,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body.canRollback, false);
  assert.ok(
    preview.body.blockers.some((b: { code: string }) => b.code === 'cross_batch_link'),
    `expected cross_batch_link blocker, got: ${JSON.stringify(preview.body.blockers)}`,
  );

  const rb = await authed.post(
    `/api/import/history/${encodeURIComponent('cross-batch-source')}/rollback`,
  );
  assert.equal(rb.status, 409);
  assert.equal(rb.body.error, 'rollback_blocked');
});

test('history endpoint exposes rollback marker fields', async () => {
  const res = await authed.get('/api/import/history');
  assert.equal(res.status, 200);
  const rolled = (res.body as Array<Record<string, unknown>>).find(
    (r) => r.batchLabel === 'rollback-batch-1',
  );
  assert.ok(rolled, 'rolled-back batch should appear in history');
  assert.equal(rolled?.status, 'rolled_back');
  assert.ok(rolled?.rolledBackAt, 'rolledBackAt should be in payload');
});
