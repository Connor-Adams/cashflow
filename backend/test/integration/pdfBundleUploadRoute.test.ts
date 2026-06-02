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
  authed = request.agent(app);
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
