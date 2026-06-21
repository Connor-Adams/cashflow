/**
 * Integration test for POST /api/import/upload-pdf-bundle.
 *
 * Verifies the atomic upload: 201 + batchId/total in the body, a
 * PdfImportBatch row (status=pending, total=2), and exactly 2 pending
 * PdfImportItem rows with non-empty storedFilename.
 *
 * Mirrors the harness in importUpload.test.ts exactly — same DB setup /
 * teardown, same auth helper.
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
const receiptsUploadDir = path.join(backendRoot, 'uploads', 'test-integration-pdf-bundle');

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

before(async () => {
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
  fs.mkdirSync(receiptsUploadDir, { recursive: true });

  // vault storage falls back to RECEIPTS_UPLOAD_DIR/vault/ when S3 is not configured
  process.env.RECEIPTS_UPLOAD_DIR = receiptsUploadDir;

  testDb = await setupPgTestDb('pdfbundle');

  models = await import('../../src/models/index.js');
  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'pdfbundle@example.com',
    displayName: 'PDF Bundle User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
});

// Minimal valid PDF-1.4 (blank page) — the handler does NOT parse content,
// so fake bytes are fine. Using two distinct buffers to exercise per-file paths.
const fakePdf1 = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
    '0000000052 00000 n \n0000000101 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF',
  'binary',
);
const fakePdf2 = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
    '0000000052 00000 n \n0000000101 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF',
  'binary',
);

test('POST /api/import/upload-pdf-bundle: 201 + batch + 2 items created', async () => {
  const res = await authed
    .post('/api/import/upload-pdf-bundle')
    .attach('files', fakePdf1, {
      filename: 'statement-a.pdf',
      contentType: 'application/pdf',
    })
    .attach('files', fakePdf2, {
      filename: 'statement-b.pdf',
      contentType: 'application/pdf',
    });

  assert.equal(res.status, 201, `expected 201 got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(typeof res.body.batchId === 'string' && res.body.batchId.length > 0,
    `expected non-empty batchId, got ${JSON.stringify(res.body)}`);
  assert.equal(res.body.total, 2, `expected total=2, got ${JSON.stringify(res.body)}`);

  const { batchId } = res.body as { batchId: string; total: number };

  // PdfImportBatch row
  const batch = await models.PdfImportBatch.findOne({ where: { id: batchId } });
  assert.ok(batch, `PdfImportBatch row not found for id=${batchId}`);
  assert.equal(batch!.status, 'pending');
  assert.equal(batch!.total, 2);

  // PdfImportItem rows
  const items = await models.PdfImportItem.findAll({ where: { batchId } });
  assert.equal(items.length, 2, `expected 2 PdfImportItem rows, got ${items.length}`);
  for (const item of items) {
    assert.equal(item.status, 'pending', `item ${item.id} status should be pending`);
    assert.ok(
      typeof item.storedFilename === 'string' && item.storedFilename.length > 0,
      `item ${item.id} storedFilename should be non-empty, got ${JSON.stringify(item.storedFilename)}`,
    );
  }
});

test('POST /api/import/upload-pdf-bundle: 400 when no files attached', async () => {
  const res = await authed.post('/api/import/upload-pdf-bundle');
  assert.equal(res.status, 400);
  assert.ok(String(res.body?.error ?? '').includes('files'));
});

test('POST /api/import/upload-pdf-bundle: 400 when non-pdf file attached', async () => {
  const res = await authed
    .post('/api/import/upload-pdf-bundle')
    .attach('files', Buffer.from('not,a,pdf\n'), {
      filename: 'bad.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// GET /api/import/pdf-batch/:id — progress endpoint tests
// ---------------------------------------------------------------------------

test('GET /api/import/pdf-batch/:id: 200 with batch + items', async () => {
  const crypto = await import('node:crypto');
  const { PdfImportBatch, PdfImportItem } = models;

  // Retrieve the household id from the session (POST a no-op and read the
  // batch we just created to find householdId).
  const uploadRes = await authed
    .post('/api/import/upload-pdf-bundle')
    .attach('files', fakePdf1, { filename: 'progress-a.pdf', contentType: 'application/pdf' });
  assert.equal(uploadRes.status, 201);
  const { batchId: seedBatchId } = uploadRes.body as { batchId: string };
  const seedBatch = await PdfImportBatch.findOne({ where: { id: seedBatchId } });
  assert.ok(seedBatch);
  const householdId = seedBatch!.householdId;

  // Create a batch with controlled data
  const batchId = crypto.randomUUID();
  await PdfImportBatch.create({
    id: batchId,
    householdId,
    userId: seedBatch!.userId,
    status: 'processing',
    total: 2,
    processed: 2,
    succeeded: 1,
    failed: 1,
  });
  const doneItemId = crypto.randomUUID();
  await PdfImportItem.create({
    id: doneItemId,
    batchId,
    fileName: 'done.pdf',
    storedFilename: 'dummy-done.pdf',
    storageKind: 'local',
    encryptionAlgorithm: 'none',
    status: 'done',
    resultJson: {
      accountName: 'WS Credit Card',
      insertedTransactions: 5,
      insertedInvestmentActivities: 2,
      insertedHoldings: 1,
      skippedDuplicates: 3,
    },
    error: null,
  });
  const failedItemId = crypto.randomUUID();
  await PdfImportItem.create({
    id: failedItemId,
    batchId,
    fileName: 'failed.pdf',
    storedFilename: 'dummy-failed.pdf',
    storageKind: 'local',
    encryptionAlgorithm: 'none',
    status: 'failed',
    resultJson: null,
    error: 'No PDF parser matched this statement layout',
  });

  const res = await authed.get(`/api/import/pdf-batch/${batchId}`);
  assert.equal(res.status, 200, `expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);

  const body = res.body as {
    id: string; status: string; total: number; processed: number;
    succeeded: number; failed: number;
    items: Array<{
      fileName: string; status: string; accountName: string | null;
      insertedTransactions: number; insertedInvestmentActivities: number;
      insertedHoldings: number; skippedDuplicates: number; error: string | null;
    }>;
  };

  assert.equal(body.id, batchId);
  assert.equal(body.status, 'processing');
  assert.equal(body.total, 2);
  assert.equal(body.processed, 2);
  assert.equal(body.succeeded, 1);
  assert.equal(body.failed, 1);
  assert.equal(body.items.length, 2);

  const doneItem = body.items.find((i) => i.fileName === 'done.pdf');
  assert.ok(doneItem, 'done item should be present');
  assert.equal(doneItem!.status, 'done');
  assert.equal(doneItem!.accountName, 'WS Credit Card');
  assert.equal(doneItem!.insertedTransactions, 5);
  assert.equal(doneItem!.insertedInvestmentActivities, 2);
  assert.equal(doneItem!.insertedHoldings, 1);
  assert.equal(doneItem!.skippedDuplicates, 3);
  assert.equal(doneItem!.error, null);

  const failedItem = body.items.find((i) => i.fileName === 'failed.pdf');
  assert.ok(failedItem, 'failed item should be present');
  assert.equal(failedItem!.status, 'failed');
  assert.equal(failedItem!.accountName, null);
  assert.equal(failedItem!.insertedTransactions, 0);
  assert.ok(
    typeof failedItem!.error === 'string' && failedItem!.error.length > 0,
    `expected non-empty error, got ${JSON.stringify(failedItem!.error)}`,
  );
});

test('GET /api/import/pdf-batch/:id: 404 for random unknown uuid', async () => {
  const { randomUUID } = await import('node:crypto');
  const res = await authed.get(`/api/import/pdf-batch/${randomUUID()}`);
  assert.equal(res.status, 404, `expected 404 got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('GET /api/import/pdf-batch/:id: 404 for a batch belonging to another household', async () => {
  const crypto = await import('node:crypto');
  const { PdfImportBatch } = models;

  // Create a second user + household to own the foreign batch
  const authed2 = testAgent(app);
  const reg2 = await authed2.post('/api/auth/register').send({
    email: 'pdfbundle2@example.com',
    displayName: 'PDF Bundle User 2',
    password: 'password123',
  });
  assert.equal(reg2.status, 201);

  // The second user uploads a batch (so we have a real householdId)
  const upload2 = await authed2
    .post('/api/import/upload-pdf-bundle')
    .attach('files', fakePdf1, { filename: 'other-user.pdf', contentType: 'application/pdf' });
  assert.equal(upload2.status, 201);
  const { batchId: otherBatchId } = upload2.body as { batchId: string };

  // Verify the other batch exists
  const otherBatch = await PdfImportBatch.findOne({ where: { id: otherBatchId } });
  assert.ok(otherBatch, 'other batch should exist in DB');

  // authed (first household) must NOT see the other household's batch
  const res = await authed.get(`/api/import/pdf-batch/${otherBatchId}`);
  assert.equal(
    res.status, 404,
    `cross-household batch should return 404, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
});
