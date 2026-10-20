import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  sequelize, PdfImportBatch, PdfImportItem, Household, User,
  Account, Transaction,
} from '../models';
import { saveVaultObject } from '../storage/vaultStorage';
import { drainPendingChunk, healEntityIdsAfterDrain } from './pdfImportProcessor';
import { ENTITY_SYNC_FAILED_WARNING } from '../tax/services/syncTransactionEntityIds';
import { skipUnlessPrivateFixtures } from '../../test/helpers/privateFixtures';
import { synthPdf } from '../../test/helpers/syntheticPdf';
import { SYN_CIBC_C, SYN_CIBC_LAST4 } from '../../test/helpers/syntheticStatements';
import { resetTestDb } from '../../test/helpers/resetTestDb';

// Connor's real Wealthsimple credit-card statement: LOCAL-ONLY (loud skip in
// CI). The synthetic twins render made-up statements to PDFs at test time.
const CC_PDF = '/Users/connoradams/Downloads/monthly_pdf_statements/C13BRX957CAD_2026-05_CREDIT_CARD.pdf';

/** Store one PDF as a pending item in a fresh batch, drain, and return the reloaded item. */
async function drainOnePdf(buffer: Buffer, fileName: string) {
  await resetTestDb(sequelize);
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({
    email: 'a@b.c',
    displayName: 'Test User',
    passwordHash: 'x',
    passwordSalt: 'y',
    passwordParams: 'p',
  } as never);
  const stored = `${crypto.randomUUID()}.pdf`;
  const put = await saveVaultObject(stored, {
    buffer, contentType: 'application/pdf', originalName: fileName,
  });
  const batch = await PdfImportBatch.create({
    id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0,
  });
  await PdfImportItem.create({
    id: crypto.randomUUID(), batchId: batch.id, fileName,
    storedFilename: put.storedFilename, storageKind: put.storageKind,
    encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending',
  });

  const summary = await drainPendingChunk({ maxItems: 12 });
  const item = await PdfImportItem.findOne({ where: { batchId: batch.id } });
  assert.equal(summary.processed, 1);
  assert.equal(summary.succeeded, 1, `drain did not succeed: ${item?.error ?? item?.reason}`);

  const reloaded = await PdfImportBatch.findByPk(batch.id);
  assert.equal(reloaded?.status, 'done');
  assert.equal(reloaded?.succeeded, 1);
  assert.equal(item?.status, 'done');
  assert.ok(item?.accountId);
  return item!;
}

test('drainPendingChunk parses a pending item and marks the batch done', { skip: skipUnlessPrivateFixtures(CC_PDF) }, async () => {
  await drainOnePdf(fs.readFileSync(CC_PDF), 'cc.pdf');
});

test('drainPendingChunk parses a pending item and marks the batch done — synthetic credit-card PDF', async () => {
  const item = await drainOnePdf(synthPdf(SYN_CIBC_C), 'cibc-costco-synthetic.pdf');
  const account = await Account.findByPk(item.accountId!);
  assert.equal(account?.shortCode, SYN_CIBC_LAST4);
  assert.equal(account?.accountType, 'credit_card');
  assert.equal(await Transaction.count({ where: { accountId: item.accountId! } }), 6);
});

test('a failing item marks failed without aborting the chunk', async () => {
  await resetTestDb(sequelize);
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({
    email: 'a@b.c',
    displayName: 'Test User',
    passwordHash: 'x',
    passwordSalt: 'y',
    passwordParams: 'p',
  } as never);
  const stored = `${crypto.randomUUID()}.pdf`;
  const put = await saveVaultObject(stored, {
    buffer: Buffer.from('not a pdf'), contentType: 'application/pdf', originalName: 'bad.pdf',
  });
  const batch = await PdfImportBatch.create({
    id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0,
  });
  await PdfImportItem.create({
    id: crypto.randomUUID(), batchId: batch.id, fileName: 'bad.pdf',
    storedFilename: put.storedFilename, storageKind: put.storageKind,
    encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending',
  });
  const summary = await drainPendingChunk({ maxItems: 12 });
  assert.equal(summary.failed, 1);
  const item = await PdfImportItem.findOne({ where: { batchId: batch.id } });
  assert.equal(item?.status, 'failed');
  assert.ok(item?.error);
  const reloaded = await PdfImportBatch.findByPk(batch.id);
  assert.equal(reloaded?.status, 'failed'); // all items failed → batch failed
  assert.equal(reloaded?.failed, 1);
});

test('pdf_import_process job is registered and runnable', async () => {
  await resetTestDb(sequelize);
  await import('../jobs/definitions/pdfImportProcess');
  const { runJobByName } = await import('../jobs/registry');
  const outcome = await runJobByName('pdf_import_process');
  // TickOutcome shape: { status: JobStatus, durationMs, jobName, runId?, result?, error? }
  // JobStatus: 'ok' | 'error' | 'skipped_disabled' | 'skipped_locked' | 'skipped_reentrant'
  assert.ok(outcome, 'should return a TickOutcome');
  assert.equal(outcome.jobName, 'pdf_import_process');
  const validStatuses = ['ok', 'error', 'skipped_disabled', 'skipped_locked', 'skipped_reentrant'];
  assert.ok(validStatuses.includes(outcome.status), `unexpected status: ${outcome.status}`);
});

test('a failed entity-id heal after a drain is recorded on the done items (visible in batch detail)', async () => {
  await resetTestDb(sequelize);
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({
    email: 'heal@b.c',
    displayName: 'Test User',
    passwordHash: 'x',
    passwordSalt: 'y',
    passwordParams: 'p',
  } as never);
  const batch = await PdfImportBatch.create({
    id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'done', total: 1, processed: 1, succeeded: 1, failed: 0,
  });
  const item = await PdfImportItem.create({
    id: crypto.randomUUID(), batchId: batch.id, fileName: 'cc.pdf',
    storedFilename: 'x.pdf', storageKind: 'disk', encryptionAlgorithm: 'none', status: 'done',
    resultJson: { accountName: 'Corp Visa', insertedTransactions: 3, warnings: ['existing warning'] },
  } as never);

  const realQuery = sequelize.query.bind(sequelize);
  const query = mock.method(sequelize, 'query', ((sql: unknown, ...rest: unknown[]) => {
    if (typeof sql === 'string' && sql.includes('SET entity_id = (')) {
      return Promise.reject(new Error('deadlock detected'));
    }
    return (realQuery as (...a: unknown[]) => unknown)(sql, ...rest);
  }) as typeof sequelize.query);
  try {
    await healEntityIdsAfterDrain([batch.id], [item.id]);
  } finally {
    query.mock.restore();
  }

  const reloaded = await PdfImportItem.findByPk(item.id);
  assert.equal(reloaded?.status, 'done', 'a heal failure must not fail the import');
  assert.equal(reloaded?.reason, ENTITY_SYNC_FAILED_WARNING);
  const rj = reloaded?.resultJson as { warnings?: string[]; insertedTransactions?: number };
  assert.deepEqual(rj.warnings, ['existing warning', ENTITY_SYNC_FAILED_WARNING]);
  assert.equal(rj.insertedTransactions, 3, 'other result fields are preserved');
});

test('a successful entity-id heal leaves done items untouched', async () => {
  await resetTestDb(sequelize);
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({
    email: 'heal2@b.c',
    displayName: 'Test User',
    passwordHash: 'x',
    passwordSalt: 'y',
    passwordParams: 'p',
  } as never);
  const batch = await PdfImportBatch.create({
    id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'done', total: 1, processed: 1, succeeded: 1, failed: 0,
  });
  const item = await PdfImportItem.create({
    id: crypto.randomUUID(), batchId: batch.id, fileName: 'cc.pdf',
    storedFilename: 'x.pdf', storageKind: 'disk', encryptionAlgorithm: 'none', status: 'done',
    resultJson: { warnings: [] },
  } as never);
  await healEntityIdsAfterDrain([batch.id], [item.id]);
  const reloaded = await PdfImportItem.findByPk(item.id);
  assert.equal(reloaded?.reason ?? null, null);
  assert.deepEqual((reloaded?.resultJson as { warnings?: string[] }).warnings, []);
});
