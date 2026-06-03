/**
 * Integration: end-to-end async PDF import pipeline (migrated Postgres).
 *
 * Proves: upload→drain→committed→batch_done→idempotent_re-run.
 *
 * Uses the migrated Postgres harness (NOT sequelize.sync) so that the
 * ws_holding unique index lives in the schema — that index is what makes the
 * HoldingSnapshot dedup work.  Mirrors pdfBundleUploadRoute.test.ts exactly
 * for DB setup/teardown.
 *
 * The test is gated on the brokerage PDF being present at:
 *   /Users/connoradams/Downloads/monthly_pdf_statements/HQ6LMLTK8CAD_2025-05_BROKERAGE.pdf
 * If absent the test is skipped automatically.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

// NOTE: vaultStorage, pdfImportProcessor, and models are dynamically imported
// inside before() AFTER setupPgTestDb sets DATABASE_URL — otherwise db.ts
// initialises a SQLite connection before Postgres is configured (mirrors the
// pattern in pdfBundleUploadRoute.test.ts).
let saveVaultObject: (typeof import('../../src/storage/vaultStorage.js'))['saveVaultObject'];
let drainPendingChunk: (typeof import('../../src/import/pdfImportProcessor.js'))['drainPendingChunk'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const receiptsUploadDir = path.join(backendRoot, 'uploads', 'test-integration-pdf-async');

const BRK = '/Users/connoradams/Downloads/monthly_pdf_statements/HQ6LMLTK8CAD_2025-05_BROKERAGE.pdf';

let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

// householdId + userId resolved from the registered user
let householdId: number;
let userId: number;

before(async () => {
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
  fs.mkdirSync(receiptsUploadDir, { recursive: true });

  // vault storage falls back to RECEIPTS_UPLOAD_DIR/vault/ when S3 is not configured
  process.env.RECEIPTS_UPLOAD_DIR = receiptsUploadDir;

  // setupPgTestDb sets DATABASE_URL — models/db.ts must NOT be imported before this point
  testDb = await setupPgTestDb('pdf-async');

  // Dynamic imports AFTER DATABASE_URL is set (mirrors pdfBundleUploadRoute.test.ts)
  models = await import('../../src/models/index.js');
  ({ saveVaultObject } = await import('../../src/storage/vaultStorage.js'));
  ({ drainPendingChunk } = await import('../../src/import/pdfImportProcessor.js'));

  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = request.agent(app);

  const register = await authed.post('/api/auth/register').send({
    email: 'pdf-async@example.com',
    displayName: 'PDF Async User',
    password: 'password123',
  });
  assert.equal(register.status, 201, `registration failed: ${JSON.stringify(register.body)}`);

  // Resolve householdId + userId from the /api/auth/me response.
  // Shape: { user: { id, ..., household: { id, ... } } }
  const me = await authed.get('/api/auth/me');
  assert.equal(me.status, 200, `GET /api/auth/me failed: ${JSON.stringify(me.body)}`);
  const meBody = me.body as { user: { id: number; household: { id: number } } };
  userId = meBody.user.id;
  householdId = meBody.user.household.id;
  assert.ok(userId, `expected userId from /api/auth/me, got ${JSON.stringify(me.body)}`);
  assert.ok(householdId, `expected householdId from /api/auth/me, got ${JSON.stringify(me.body)}`);
});

after(async () => {
  await teardownPgTestDb(testDb);
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: count HoldingSnapshot + InvestmentActivity rows for the account
// identified by shortCode HQ6LMLTK8CAD (the TFSA brokerage account).
// ---------------------------------------------------------------------------

async function countRows(): Promise<{ holdingSnapshots: number; investmentActivities: number }> {
  const { HoldingSnapshot, InvestmentActivity, Account } = models;

  const account = await Account.findOne({ where: { householdId, shortCode: 'HQ6LMLTK8CAD' } });
  if (!account) return { holdingSnapshots: 0, investmentActivities: 0 };

  const [holdingSnapshots, investmentActivities] = await Promise.all([
    HoldingSnapshot.count({ where: { accountId: account.id } }),
    InvestmentActivity.count({ where: { accountId: account.id } }),
  ]);
  return { holdingSnapshots, investmentActivities };
}

// ---------------------------------------------------------------------------
// Main integration test: upload→drain→committed→idempotent re-run
// ---------------------------------------------------------------------------

test(
  'async pdf import: drain→committed→batch done→idempotent re-run (brokerage)',
  { skip: !fs.existsSync(BRK) },
  async () => {
    const { PdfImportBatch, PdfImportItem } = models;

    // ---- Step 1: save PDF bytes to vault, create batch + item ----
    const pdfBytes = fs.readFileSync(BRK);
    const storedFilename = `${crypto.randomUUID()}.pdf`;
    const put = await saveVaultObject(storedFilename, {
      buffer: pdfBytes,
      contentType: 'application/pdf',
      originalName: path.basename(BRK),
    });

    const batch = await PdfImportBatch.create({
      id: crypto.randomUUID(),
      householdId,
      userId,
      status: 'pending',
      total: 1,
      processed: 0,
      succeeded: 0,
      failed: 0,
    });

    await PdfImportItem.create({
      id: crypto.randomUUID(),
      batchId: batch.id,
      fileName: path.basename(BRK),
      storedFilename: put.storedFilename,
      storageKind: put.storageKind,
      encryptionAlgorithm: put.encryptionAlgorithm,
      status: 'pending',
    });

    // ---- Step 2: first drain ----
    const first = await drainPendingChunk({ maxItems: 12 });

    assert.equal(first.succeeded, 1, `expected 1 succeeded, got ${JSON.stringify(first)}`);
    assert.equal(first.failed, 0, `expected 0 failed, got ${JSON.stringify(first)}`);

    // Batch must be done
    const reloadedBatch = await PdfImportBatch.findByPk(batch.id);
    assert.equal(
      reloadedBatch?.status,
      'done',
      `expected batch status=done, got ${reloadedBatch?.status}`,
    );
    assert.equal(reloadedBatch?.succeeded, 1);
    assert.equal(reloadedBatch?.failed, 0);

    // Item must be done with an accountId
    const item = await PdfImportItem.findOne({ where: { batchId: batch.id } });
    assert.equal(item?.status, 'done', `expected item status=done, got ${item?.status}`);
    assert.ok(item?.accountId, `expected item.accountId to be set`);

    // HoldingSnapshot + InvestmentActivity rows must have been committed
    const after1 = await countRows();
    assert.ok(
      after1.holdingSnapshots > 0 || after1.investmentActivities > 0,
      `expected HoldingSnapshot or InvestmentActivity rows after first drain; got ${JSON.stringify(after1)}`,
    );

    // Capture counts from resultJson for idempotency comparison
    const rj1 = (item?.resultJson ?? {}) as Record<string, number>;
    const insertedHoldings1 = rj1.insertedHoldings ?? after1.holdingSnapshots;
    const insertedActivities1 = rj1.insertedInvestmentActivities ?? after1.investmentActivities;

    // ---- Step 3: idempotency — fresh pending item for the same file + same household ----
    // Re-save the same bytes (or reuse the stored key) in a new batch.
    const storedFilename2 = `${crypto.randomUUID()}.pdf`;
    const put2 = await saveVaultObject(storedFilename2, {
      buffer: pdfBytes,
      contentType: 'application/pdf',
      originalName: path.basename(BRK),
    });

    const batch2 = await PdfImportBatch.create({
      id: crypto.randomUUID(),
      householdId,
      userId,
      status: 'pending',
      total: 1,
      processed: 0,
      succeeded: 0,
      failed: 0,
    });

    await PdfImportItem.create({
      id: crypto.randomUUID(),
      batchId: batch2.id,
      fileName: path.basename(BRK),
      storedFilename: put2.storedFilename,
      storageKind: put2.storageKind,
      encryptionAlgorithm: put2.encryptionAlgorithm,
      status: 'pending',
    });

    const second = await drainPendingChunk({ maxItems: 12 });
    // Second run must also succeed (processor shouldn't hard-fail on duplicates)
    assert.equal(second.succeeded, 1, `expected second drain succeeded=1, got ${JSON.stringify(second)}`);

    // Read second item's resultJson for dedup evidence
    const item2 = await PdfImportItem.findOne({ where: { batchId: batch2.id } });
    const rj2 = (item2?.resultJson ?? {}) as Record<string, number>;
    const insertedHoldings2 = rj2.insertedHoldings ?? 0;
    const insertedActivities2 = rj2.insertedInvestmentActivities ?? 0;

    // The second run must NOT have inserted more InvestmentActivity rows —
    // the content-hash dedup in commitStatementImport short-circuits them.
    assert.equal(
      insertedActivities2,
      0,
      `idempotency: expected 0 new InvestmentActivity on re-run (dedup), got ${insertedActivities2} (first run inserted ${insertedActivities1})`,
    );

    // HoldingSnapshot dedup: the ws_holding unique index (only present in
    // migrated Postgres, not sqlite) absorbs re-inserts via upsert.
    // Net new HoldingSnapshot rows across the two runs must equal run-1 count.
    const after2 = await countRows();
    assert.equal(
      after2.holdingSnapshots,
      after1.holdingSnapshots,
      `idempotency: HoldingSnapshot count grew from ${after1.holdingSnapshots} to ${after2.holdingSnapshots} on re-run (expected no growth); insertedHoldings2=${insertedHoldings2}`,
    );
    // Allow 0 new activities (strict) or the same total rows (lenient fallback)
    assert.equal(
      after2.investmentActivities,
      after1.investmentActivities,
      `idempotency: InvestmentActivity count grew from ${after1.investmentActivities} to ${after2.investmentActivities} on re-run (expected no growth)`,
    );
  },
);

// ---------------------------------------------------------------------------
// Optional HTTP path smoke test: POST→drain→GET batch done
// ---------------------------------------------------------------------------

test(
  'async pdf import: HTTP upload→drain→GET /api/import/pdf-batch/:id (brokerage)',
  { skip: !fs.existsSync(BRK) },
  async () => {
    const pdfBytes = fs.readFileSync(BRK);
    const { PdfImportBatch } = models;

    // POST to upload endpoint
    const uploadRes = await authed
      .post('/api/import/upload-pdf-bundle')
      .attach('files', pdfBytes, {
        filename: path.basename(BRK),
        contentType: 'application/pdf',
      });

    assert.equal(
      uploadRes.status,
      201,
      `expected 201 from upload, got ${uploadRes.status}: ${JSON.stringify(uploadRes.body)}`,
    );
    assert.ok(
      typeof uploadRes.body.batchId === 'string' && uploadRes.body.batchId.length > 0,
      `expected non-empty batchId in response body, got ${JSON.stringify(uploadRes.body)}`,
    );

    const { batchId } = uploadRes.body as { batchId: string; total: number };

    // The upload handler kicks one drain inline (best-effort via runJobByName).
    // We drain explicitly here to ensure the item is processed synchronously.
    await drainPendingChunk({ maxItems: 12 });

    // GET progress endpoint
    const progressRes = await authed.get(`/api/import/pdf-batch/${batchId}`);
    assert.equal(
      progressRes.status,
      200,
      `expected 200 from GET /api/import/pdf-batch/:id, got ${progressRes.status}: ${JSON.stringify(progressRes.body)}`,
    );

    const body = progressRes.body as {
      id: string;
      status: string;
      total: number;
      processed: number;
      succeeded: number;
      failed: number;
      items: Array<{
        fileName: string;
        status: string;
        accountName: string | null;
        insertedTransactions: number;
        insertedInvestmentActivities: number;
        insertedHoldings: number;
        skippedDuplicates: number;
        error: string | null;
      }>;
    };

    assert.equal(body.id, batchId);
    assert.equal(body.status, 'done', `expected status=done, got ${body.status}`);
    assert.equal(body.total, 1);
    assert.equal(body.succeeded, 1);
    assert.equal(body.failed, 0);
    assert.equal(body.items.length, 1);

    const item = body.items[0];
    assert.equal(item.status, 'done');
    assert.ok(
      typeof item.accountName === 'string' && item.accountName.length > 0,
      `expected non-empty accountName, got ${JSON.stringify(item.accountName)}`,
    );

    // Verify the batch row directly
    const batchRow = await PdfImportBatch.findOne({ where: { id: batchId } });
    assert.equal(batchRow?.status, 'done');
  },
);
