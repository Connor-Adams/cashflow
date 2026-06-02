import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sequelize, PdfImportBatch, PdfImportItem, Household, User } from '../src/models';
import { saveVaultObject } from '../src/storage/vaultStorage';
import { drainPendingChunk } from '../src/import/pdfImportProcessor';

const CC_PDF = '/Users/connoradams/Downloads/monthly_pdf_statements/C13BRX957CAD_2026-05_CREDIT_CARD.pdf';

test('drainPendingChunk parses a pending item and marks the batch done', { skip: !fs.existsSync(CC_PDF) }, async () => {
  await sequelize.sync({ force: true });
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
    buffer: fs.readFileSync(CC_PDF), contentType: 'application/pdf', originalName: 'cc.pdf',
  });
  const batch = await PdfImportBatch.create({
    id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0,
  });
  await PdfImportItem.create({
    id: crypto.randomUUID(), batchId: batch.id, fileName: 'cc.pdf',
    storedFilename: put.storedFilename, storageKind: put.storageKind,
    encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending',
  });

  const summary = await drainPendingChunk({ chunk: 12 });
  assert.equal(summary.processed, 1);
  assert.equal(summary.succeeded, 1);

  const reloaded = await PdfImportBatch.findByPk(batch.id);
  assert.equal(reloaded?.status, 'done');
  assert.equal(reloaded?.succeeded, 1);
  const item = await PdfImportItem.findOne({ where: { batchId: batch.id } });
  assert.equal(item?.status, 'done');
  assert.ok(item?.accountId);
});

test('a failing item marks failed without aborting the chunk', async () => {
  await sequelize.sync({ force: true });
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
  const summary = await drainPendingChunk({ chunk: 12 });
  assert.equal(summary.failed, 1);
  const item = await PdfImportItem.findOne({ where: { batchId: batch.id } });
  assert.equal(item?.status, 'failed');
  assert.ok(item?.error);
  const reloaded = await PdfImportBatch.findByPk(batch.id);
  assert.equal(reloaded?.status, 'failed'); // all items failed → batch failed
  assert.equal(reloaded?.failed, 1);
});
