/**
 * Integration tests for the import observability endpoints:
 *   - GET  /api/import/pdf-batch/:id  (extended with skipped/ETA/reason)
 *   - GET  /api/import/pdf-batches
 *   - POST /api/import/pdf-batch/:id/retry
 *
 * Mirrors the Postgres+auth+supertest harness from pdfBundleUploadRoute.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let models: typeof import('../../src/models/index.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const receiptsUploadDir = path.join(backendRoot, 'uploads', 'test-integration-observability');

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

before(async () => {
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
  fs.mkdirSync(receiptsUploadDir, { recursive: true });

  process.env.RECEIPTS_UPLOAD_DIR = receiptsUploadDir;

  testDb = await setupPgTestDb('observability');

  models = await import('../../src/models/index.js');
  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'observability@example.com',
    displayName: 'Observability User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
});

// Minimal valid PDF bytes for upload (handler stores without parsing)
const fakePdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
    '0000000052 00000 n \n0000000101 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF',
  'binary',
);

/**
 * Helper: get the householdId + userId for the authed session by uploading
 * a batch and inspecting the created row.
 */
async function getSessionIds(): Promise<{ householdId: number; userId: number }> {
  const uploadRes = await authed
    .post('/api/import/upload-pdf-bundle')
    .attach('files', fakePdf, { filename: 'seed.pdf', contentType: 'application/pdf' });
  assert.equal(uploadRes.status, 201);
  const { batchId } = uploadRes.body as { batchId: string };
  const seedBatch = await models.PdfImportBatch.findOne({ where: { id: batchId } });
  assert.ok(seedBatch);
  return { householdId: seedBatch!.householdId, userId: seedBatch!.userId };
}

// ---------------------------------------------------------------------------
// GET /api/import/pdf-batch/:id  — extended fields
// ---------------------------------------------------------------------------

test('GET /pdf-batch/:id returns skipped, estimatedRemainingMs, and item reasons', async () => {
  const { householdId, userId } = await getSessionIds();
  const { PdfImportBatch, PdfImportItem } = models;

  const batchId = crypto.randomUUID();
  // total=3, processed=2 (1 done + 1 failed + 1 skipped), 1 pending
  // startedAt set so ETA can be computed for pending item
  await PdfImportBatch.create({
    id: batchId,
    householdId,
    userId,
    status: 'processing',
    total: 3,
    processed: 2,
    succeeded: 1,
    failed: 0,
    skipped: 1,
    startedAt: new Date(Date.now() - 5000), // 5s ago
  } as never);

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
      accountName: 'RBC Chequing',
      insertedTransactions: 3,
      insertedInvestmentActivities: 0,
      insertedHoldings: 0,
      skippedDuplicates: 1,
    },
    error: null,
    reason: null,
  } as never);

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
    error: 'Unexpected PDF structure',
    reason: 'Unexpected PDF structure',
  } as never);

  const skippedItemId = crypto.randomUUID();
  await PdfImportItem.create({
    id: skippedItemId,
    batchId,
    fileName: 'skipped.pdf',
    storedFilename: 'dummy-skipped.pdf',
    storageKind: 'local',
    encryptionAlgorithm: 'none',
    status: 'skipped',
    resultJson: null,
    error: null,
    reason: 'No parser matched this statement layout',
  } as never);

  const res = await authed.get(`/api/import/pdf-batch/${batchId}`);
  assert.equal(res.status, 200, `expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);

  const body = res.body as {
    id: string; status: string; total: number; processed: number;
    succeeded: number; failed: number; skipped: number;
    startedAt: string | null; estimatedRemainingMs: number | null;
    items: Array<{
      fileName: string; status: string; accountName: string | null;
      insertedTransactions: number; reason: string | null; error: string | null;
    }>;
  };

  assert.equal(body.id, batchId);
  assert.equal(body.total, 3);
  assert.equal(body.processed, 2);
  assert.equal(body.succeeded, 1);
  assert.equal(body.skipped, 1, `expected skipped=1, got ${body.skipped}`);
  assert.ok(body.startedAt !== undefined, 'startedAt should be present');

  // pending=1 (total 3 - processed 2), startedAt set, processed>0 → ETA should be a number
  assert.ok(
    body.estimatedRemainingMs === null || typeof body.estimatedRemainingMs === 'number',
    `estimatedRemainingMs should be number or null, got ${JSON.stringify(body.estimatedRemainingMs)}`,
  );
  // With processed=2 and pending=1 and startedAt set, ETA should compute to a positive number
  assert.ok(
    typeof body.estimatedRemainingMs === 'number' && body.estimatedRemainingMs > 0,
    `expected positive estimatedRemainingMs, got ${body.estimatedRemainingMs}`,
  );

  assert.equal(body.items.length, 3);

  const doneItem = body.items.find((i) => i.fileName === 'done.pdf');
  assert.ok(doneItem, 'done item should be present');
  assert.equal(doneItem!.status, 'done');
  assert.equal(doneItem!.accountName, 'RBC Chequing');
  assert.equal(doneItem!.insertedTransactions, 3);
  assert.equal(doneItem!.reason, null);
  assert.equal(doneItem!.error, null);

  const failedItem = body.items.find((i) => i.fileName === 'failed.pdf');
  assert.ok(failedItem, 'failed item should be present');
  assert.equal(failedItem!.status, 'failed');
  assert.ok(
    typeof failedItem!.error === 'string' && failedItem!.error.length > 0,
    `expected non-empty error, got ${JSON.stringify(failedItem!.error)}`,
  );
  assert.ok(
    typeof failedItem!.reason === 'string' && failedItem!.reason.length > 0,
    `expected non-empty reason, got ${JSON.stringify(failedItem!.reason)}`,
  );

  const skippedItem = body.items.find((i) => i.fileName === 'skipped.pdf');
  assert.ok(skippedItem, 'skipped item should be present');
  assert.equal(skippedItem!.status, 'skipped');
  assert.equal(
    skippedItem!.reason,
    'No parser matched this statement layout',
    `expected skipped reason, got ${JSON.stringify(skippedItem!.reason)}`,
  );
  assert.equal(skippedItem!.error, null);
});

test('GET /pdf-batch/:id: estimatedRemainingMs is null when all processed', async () => {
  const { householdId, userId } = await getSessionIds();
  const { PdfImportBatch, PdfImportItem } = models;

  const batchId = crypto.randomUUID();
  await PdfImportBatch.create({
    id: batchId,
    householdId,
    userId,
    status: 'done',
    total: 1,
    processed: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    startedAt: new Date(),
  } as never);
  await PdfImportItem.create({
    id: crypto.randomUUID(),
    batchId,
    fileName: 'complete.pdf',
    storedFilename: 'dummy-complete.pdf',
    storageKind: 'local',
    encryptionAlgorithm: 'none',
    status: 'done',
  } as never);

  const res = await authed.get(`/api/import/pdf-batch/${batchId}`);
  assert.equal(res.status, 200);
  const body = res.body as { estimatedRemainingMs: number | null; skipped: number };
  // pending=0 → ETA should be null
  assert.equal(body.estimatedRemainingMs, null, `expected null ETA when all done, got ${body.estimatedRemainingMs}`);
  assert.equal(body.skipped, 0);
});

// ---------------------------------------------------------------------------
// GET /api/import/pdf-batches
// ---------------------------------------------------------------------------

test('GET /pdf-batches lists the household batches', async () => {
  const { householdId, userId } = await getSessionIds();
  const { PdfImportBatch } = models;

  const batchId = crypto.randomUUID();
  await PdfImportBatch.create({
    id: batchId,
    householdId,
    userId,
    status: 'done',
    total: 2,
    processed: 2,
    succeeded: 1,
    failed: 0,
    skipped: 1,
    startedAt: new Date(),
  } as never);

  const res = await authed.get('/api/import/pdf-batches');
  assert.equal(res.status, 200, `expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);

  const list = res.body as Array<{
    id: string; status: string; total: number; processed: number;
    succeeded: number; failed: number; skipped: number;
    createdAt: string; startedAt: string | null;
  }>;
  assert.ok(Array.isArray(list), 'response should be an array');

  const found = list.find((b) => b.id === batchId);
  assert.ok(found, `batch ${batchId} should appear in /pdf-batches response`);
  assert.equal(found!.status, 'done');
  assert.equal(found!.total, 2);
  assert.equal(found!.succeeded, 1);
  assert.equal(found!.skipped, 1);
  assert.ok(found!.startedAt !== undefined, 'startedAt should be present');
  assert.ok(typeof found!.createdAt === 'string', 'createdAt should be a string');
});

test('GET /pdf-batches does not return batches from other households', async () => {
  // Create a second user + household
  const authed2 = request.agent(app);
  const reg2 = await authed2.post('/api/auth/register').send({
    email: 'observability2@example.com',
    displayName: 'Observability User 2',
    password: 'password123',
  });
  assert.equal(reg2.status, 201);

  // Other household uploads a batch
  const upload2 = await authed2
    .post('/api/import/upload-pdf-bundle')
    .attach('files', fakePdf, { filename: 'other.pdf', contentType: 'application/pdf' });
  assert.equal(upload2.status, 201);
  const { batchId: otherBatchId } = upload2.body as { batchId: string };

  // authed (first household) must NOT see it
  const res = await authed.get('/api/import/pdf-batches');
  assert.equal(res.status, 200);
  const list = res.body as Array<{ id: string }>;
  assert.ok(!list.some((b) => b.id === otherBatchId), 'other household batch should not be in list');
});

// ---------------------------------------------------------------------------
// POST /api/import/pdf-batch/:id/retry
// ---------------------------------------------------------------------------

test('POST /pdf-batch/:id/retry flips failed items to pending and returns retried count', async () => {
  const { householdId, userId } = await getSessionIds();
  const { PdfImportBatch, PdfImportItem } = models;

  const batchId = crypto.randomUUID();
  await PdfImportBatch.create({
    id: batchId,
    householdId,
    userId,
    status: 'failed',
    total: 2,
    processed: 2,
    succeeded: 1,
    failed: 1,
    skipped: 0,
    startedAt: new Date(),
  } as never);
  await PdfImportItem.create({
    id: crypto.randomUUID(),
    batchId,
    fileName: 'ok.pdf',
    storedFilename: 'dummy-ok.pdf',
    storageKind: 'local',
    encryptionAlgorithm: 'none',
    status: 'done',
  } as never);
  const failedItemId = crypto.randomUUID();
  await PdfImportItem.create({
    id: failedItemId,
    batchId,
    fileName: 'bad.pdf',
    storedFilename: 'dummy-bad.pdf',
    storageKind: 'local',
    encryptionAlgorithm: 'none',
    status: 'failed',
    error: 'Parse failed',
    reason: 'Parse failed',
  } as never);

  const res = await authed.post(`/api/import/pdf-batch/${batchId}/retry`);
  assert.equal(res.status, 200, `expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);

  const body = res.body as { id: string; retried: number; status: string };
  assert.equal(body.id, batchId);
  assert.equal(body.retried, 1, `expected retried=1, got ${body.retried}`);
  assert.equal(body.status, 'processing', `expected status=processing, got ${body.status}`);

  // Verify the failed item was flipped to pending
  const item = await PdfImportItem.findByPk(failedItemId);
  assert.equal(item!.status, 'pending', `failed item should be pending after retry, got ${item!.status}`);
  assert.equal(item!.error, null, 'error should be cleared after retry');
  assert.equal(item!.reason, null, 'reason should be cleared after retry');

  // Verify batch counts were immediately recomputed (failed dropped, processed dropped)
  const batchRes = await authed.get(`/api/import/pdf-batch/${batchId}`);
  assert.equal(batchRes.status, 200, `expected 200 on batch GET after retry, got ${batchRes.status}`);
  const batchBody = batchRes.body as { failed: number; processed: number; status: string };
  assert.equal(batchBody.failed, 0, `expected failed=0 after retry (was 1), got ${batchBody.failed}`);
  assert.equal(batchBody.processed, 1, `expected processed=1 after retry (pending item excluded), got ${batchBody.processed}`);
  assert.equal(batchBody.status, 'processing', `expected batch status=processing after retry, got ${batchBody.status}`);
});

test('POST /pdf-batch/:id/retry returns retried=0 when no failed items', async () => {
  const { householdId, userId } = await getSessionIds();
  const { PdfImportBatch, PdfImportItem } = models;

  const batchId = crypto.randomUUID();
  await PdfImportBatch.create({
    id: batchId,
    householdId,
    userId,
    status: 'done',
    total: 1,
    processed: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    startedAt: null,
  } as never);
  await PdfImportItem.create({
    id: crypto.randomUUID(),
    batchId,
    fileName: 'fine.pdf',
    storedFilename: 'dummy-fine.pdf',
    storageKind: 'local',
    encryptionAlgorithm: 'none',
    status: 'done',
  } as never);

  const res = await authed.post(`/api/import/pdf-batch/${batchId}/retry`);
  assert.equal(res.status, 200);
  const body = res.body as { retried: number; status: string };
  assert.equal(body.retried, 0);
  // status unchanged since no items were re-queued
  assert.equal(body.status, 'done');
});

// ---------------------------------------------------------------------------
// Cross-household security
// ---------------------------------------------------------------------------

test('GET /pdf-batch/:id 404 for cross-household batch', async () => {
  const { PdfImportBatch } = models;

  // Create a second user/household
  const authed2 = request.agent(app);
  const reg2 = await authed2.post('/api/auth/register').send({
    email: 'observability-xhh@example.com',
    displayName: 'Observability XHH User',
    password: 'password123',
  });
  assert.equal(reg2.status, 201);

  const upload2 = await authed2
    .post('/api/import/upload-pdf-bundle')
    .attach('files', fakePdf, { filename: 'xhh.pdf', contentType: 'application/pdf' });
  assert.equal(upload2.status, 201);
  const { batchId: otherBatchId } = upload2.body as { batchId: string };

  // Verify it exists in DB
  const otherBatch = await PdfImportBatch.findOne({ where: { id: otherBatchId } });
  assert.ok(otherBatch, 'other batch should exist');

  // authed (household 1) must see 404
  const res = await authed.get(`/api/import/pdf-batch/${otherBatchId}`);
  assert.equal(res.status, 404, `cross-household GET should return 404, got ${res.status}`);
});

test('POST /pdf-batch/:id/retry 404 for cross-household batch', async () => {
  const { PdfImportBatch } = models;

  // Create a second user/household
  const authed2 = request.agent(app);
  const reg2 = await authed2.post('/api/auth/register').send({
    email: 'observability-xhh2@example.com',
    displayName: 'Observability XHH2 User',
    password: 'password123',
  });
  assert.equal(reg2.status, 201);

  const upload2 = await authed2
    .post('/api/import/upload-pdf-bundle')
    .attach('files', fakePdf, { filename: 'xhh2.pdf', contentType: 'application/pdf' });
  assert.equal(upload2.status, 201);
  const { batchId: otherBatchId } = upload2.body as { batchId: string };

  const otherBatch = await PdfImportBatch.findOne({ where: { id: otherBatchId } });
  assert.ok(otherBatch, 'other batch should exist');

  // authed (household 1) must see 404
  const res = await authed.post(`/api/import/pdf-batch/${otherBatchId}/retry`);
  assert.equal(res.status, 404, `cross-household retry should return 404, got ${res.status}`);
});

// ---------------------------------------------------------------------------
// E2E: real PDFs — skipped-vs-done + retry no-op (gated on PDF presence)
// ---------------------------------------------------------------------------

const BRK_PDF = '/Users/connoradams/Downloads/monthly_pdf_statements/HQ6LMLTK8CAD_2025-05_BROKERAGE.pdf';
const PERF_PDF = '/Users/connoradams/Downloads/monthly_pdf_statements/HQ8H0GZ07CAD_2025-01_YEARLY_PERFORMANCE.pdf';

// NOTE: vaultStorage and drainPendingChunk must be dynamically imported AFTER
// setupPgTestDb sets DATABASE_URL (same pattern as pdfImportAsync.test.ts).
let saveVaultObject: (typeof import('../../src/storage/vaultStorage.js'))['saveVaultObject'];
let drainPendingChunk: (typeof import('../../src/import/pdfImportProcessor.js'))['drainPendingChunk'];

// Resolved once the first e2e test runs (from /api/auth/me, same session as authed)
let e2eHouseholdId: number;
let e2eUserId: number;

test(
  'e2e: brokerage done + performance skipped — batch totals + GET route + retry no-op',
  { skip: !(fs.existsSync(BRK_PDF) && fs.existsSync(PERF_PDF)) },
  async () => {
    // Dynamic imports (same lazy pattern as pdfImportAsync.test.ts)
    if (!saveVaultObject) {
      ({ saveVaultObject } = await import('../../src/storage/vaultStorage.js'));
    }
    if (!drainPendingChunk) {
      ({ drainPendingChunk } = await import('../../src/import/pdfImportProcessor.js'));
    }

    // Resolve householdId + userId from the authenticated session
    const me = await authed.get('/api/auth/me');
    assert.equal(me.status, 200, `GET /api/auth/me failed: ${JSON.stringify(me.body)}`);
    const meBody = me.body as { user: { id: number; household: { id: number } } };
    e2eUserId = meBody.user.id;
    e2eHouseholdId = meBody.user.household.id;
    assert.ok(e2eUserId, `expected userId from /api/auth/me`);
    assert.ok(e2eHouseholdId, `expected householdId from /api/auth/me`);

    const { PdfImportBatch, PdfImportItem, HoldingSnapshot, InvestmentActivity, Account } = models;

    // ---- Step 1: save both PDFs to vault ----
    const brkBytes = fs.readFileSync(BRK_PDF);
    const perfBytes = fs.readFileSync(PERF_PDF);

    const brkPut = await saveVaultObject(`${crypto.randomUUID()}.pdf`, {
      buffer: brkBytes,
      contentType: 'application/pdf',
      originalName: path.basename(BRK_PDF),
    });
    const perfPut = await saveVaultObject(`${crypto.randomUUID()}.pdf`, {
      buffer: perfBytes,
      contentType: 'application/pdf',
      originalName: path.basename(PERF_PDF),
    });

    // ---- Step 2: create batch (total=2) + two pending items ----
    const batchId = crypto.randomUUID();
    await PdfImportBatch.create({
      id: batchId,
      householdId: e2eHouseholdId,
      userId: e2eUserId,
      status: 'pending',
      total: 2,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      startedAt: null,
    } as never);

    const brkItemId = crypto.randomUUID();
    await PdfImportItem.create({
      id: brkItemId,
      batchId,
      fileName: path.basename(BRK_PDF),
      storedFilename: brkPut.storedFilename,
      storageKind: brkPut.storageKind,
      encryptionAlgorithm: brkPut.encryptionAlgorithm,
      status: 'pending',
    } as never);

    const perfItemId = crypto.randomUUID();
    await PdfImportItem.create({
      id: perfItemId,
      batchId,
      fileName: path.basename(PERF_PDF),
      storedFilename: perfPut.storedFilename,
      storageKind: perfPut.storageKind,
      encryptionAlgorithm: perfPut.encryptionAlgorithm,
      status: 'pending',
    } as never);

    // ---- Step 3: drain ----
    await drainPendingChunk({ maxItems: 12 });

    // ---- Step 4: assert item outcomes ----
    const brkItem = await PdfImportItem.findByPk(brkItemId);
    assert.equal(brkItem?.status, 'done', `expected brokerage item=done, got ${brkItem?.status}`);
    assert.ok(brkItem?.accountId, `expected brokerage item.accountId to be set`);

    // Brokerage account must have committed HoldingSnapshot or InvestmentActivity rows
    const brkAccount = await Account.findOne({ where: { id: brkItem!.accountId! } });
    assert.ok(brkAccount, 'expected brokerage account to exist');
    const [holdingCount, activityCount] = await Promise.all([
      HoldingSnapshot.count({ where: { accountId: brkAccount!.id } }),
      InvestmentActivity.count({ where: { accountId: brkAccount!.id } }),
    ]);
    assert.ok(
      holdingCount > 0 || activityCount > 0,
      `expected committed rows for brokerage account; HoldingSnapshot=${holdingCount}, InvestmentActivity=${activityCount}`,
    );

    const perfItem = await PdfImportItem.findByPk(perfItemId);
    assert.equal(perfItem?.status, 'skipped', `expected performance item=skipped, got ${perfItem?.status}`);
    assert.match(
      perfItem?.reason ?? '',
      /No parser matched/i,
      `expected reason matching /No parser matched/, got ${JSON.stringify(perfItem?.reason)}`,
    );

    // ---- Step 5: assert batch totals ----
    const batch = await PdfImportBatch.findByPk(batchId);
    assert.equal(batch?.status, 'done', `expected batch status=done, got ${batch?.status}`);
    assert.equal(batch?.succeeded, 1, `expected succeeded=1, got ${batch?.succeeded}`);
    assert.equal(batch?.skipped, 1, `expected skipped=1, got ${batch?.skipped}`);
    assert.equal(batch?.failed, 0, `expected failed=0, got ${batch?.failed}`);
    assert.equal(batch?.processed, 2, `expected processed=2, got ${batch?.processed}`);
    assert.ok(batch?.startedAt, `expected startedAt to be set`);

    // ---- Step 6: GET /api/import/pdf-batch/:id ----
    const getRes = await authed.get(`/api/import/pdf-batch/${batchId}`);
    assert.equal(getRes.status, 200, `expected 200, got ${getRes.status}: ${JSON.stringify(getRes.body)}`);

    const getBody = getRes.body as {
      id: string; status: string; total: number; processed: number;
      succeeded: number; failed: number; skipped: number;
      startedAt: string | null; estimatedRemainingMs: number | null;
      items: Array<{ fileName: string; status: string; reason: string | null }>;
    };

    assert.equal(getBody.skipped, 1, `GET /pdf-batch: expected skipped=1, got ${getBody.skipped}`);
    // All items processed → no pending remaining → estimatedRemainingMs must be null
    assert.equal(
      getBody.estimatedRemainingMs,
      null,
      `expected estimatedRemainingMs=null when all processed, got ${getBody.estimatedRemainingMs}`,
    );

    const skippedRouteItem = getBody.items.find((i) => i.fileName === path.basename(PERF_PDF));
    assert.ok(skippedRouteItem, `expected skipped item in GET response items`);
    assert.equal(skippedRouteItem!.status, 'skipped');
    assert.ok(
      typeof skippedRouteItem!.reason === 'string' && skippedRouteItem!.reason.length > 0,
      `expected non-empty reason on skipped item, got ${JSON.stringify(skippedRouteItem!.reason)}`,
    );

    // ---- Step 7: POST /api/import/pdf-batch/:id/retry — no-op (no failed items) ----
    const retryRes = await authed.post(`/api/import/pdf-batch/${batchId}/retry`);
    assert.equal(retryRes.status, 200, `expected 200 from retry, got ${retryRes.status}: ${JSON.stringify(retryRes.body)}`);
    const retryBody = retryRes.body as { retried: number; status: string };
    assert.equal(retryBody.retried, 0, `expected retried=0 (no failed items), got ${retryBody.retried}`);
    assert.equal(retryBody.status, 'done', `expected batch stays done after retry no-op, got ${retryBody.status}`);
  },
);
