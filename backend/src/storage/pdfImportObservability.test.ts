import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sequelize, PdfImportBatch, PdfImportItem, Household, User } from '../models';
import { saveVaultObject } from './vaultStorage';
import { drainPendingChunk } from '../import/pdfImportProcessor';
import { skipUnlessPrivateFixtures } from '../../test/helpers/privateFixtures';
import { synthPdf } from '../../test/helpers/syntheticPdf';
import { SYN_UNRECOGNIZED } from '../../test/helpers/syntheticStatements';
import { resetTestDb } from '../../test/helpers/resetTestDb';

// Connor's real yearly-performance PDF: LOCAL-ONLY (loud skip in CI). The
// synthetic twin renders a made-up non-statement PDF at test time.
const PERFORMANCE_PDF = '/Users/connoradams/Downloads/monthly_pdf_statements/HQ8H0GZ07CAD_2025-01_YEARLY_PERFORMANCE.pdf';

async function hhUser() {
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({ email: 'a@b.c', householdId: hh.id, displayName: 'T', passwordHash: 'x', passwordSalt: 'y', passwordParams: 'p' } as never);
  return { hh, u };
}

test('batch has skipped + startedAt; item has reason; skipped status persists', async () => {
  await resetTestDb(sequelize);
  const { hh, u } = await hhUser();
  const b = await PdfImportBatch.create({ id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0, skipped: 0, startedAt: null });
  const i = await PdfImportItem.create({ id: crypto.randomUUID(), batchId: b.id, fileName: 'x.pdf', storedFilename: 'k.pdf', storageKind: 'local', encryptionAlgorithm: 'none', status: 'skipped', reason: 'No parser matched this statement layout' });
  const got = await PdfImportItem.findByPk(i.id);
  assert.equal(got?.status, 'skipped');
  assert.equal(got?.reason, 'No parser matched this statement layout');
});

test('drain reports pendingRemaining and respects maxItems', async () => {
  await resetTestDb(sequelize);
  const { hh, u } = await hhUser();
  const b = await PdfImportBatch.create({ id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 3, processed: 0, succeeded: 0, failed: 0, skipped: 0, startedAt: null });
  for (let k = 0; k < 3; k++) {
    const put = await saveVaultObject(`${crypto.randomUUID()}.pdf`, { buffer: Buffer.from('not a pdf'), contentType: 'application/pdf', originalName: 'b.pdf' });
    await PdfImportItem.create({ id: crypto.randomUUID(), batchId: b.id, fileName: 'b.pdf', storedFilename: put.storedFilename, storageKind: put.storageKind, encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending' });
  }
  const s = await drainPendingChunk({ maxItems: 2 });
  assert.equal(s.processed, 2);
  assert.equal(s.pendingRemaining, 1);
});

async function assertNoParserFileIsSkipped(buffer: Buffer) {
  await resetTestDb(sequelize);
  const { hh, u } = await hhUser();
  const put = await saveVaultObject(`${crypto.randomUUID()}.pdf`, {
    buffer,
    contentType: 'application/pdf',
    originalName: 'performance.pdf',
  });
  const b = await PdfImportBatch.create({ id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0, skipped: 0, startedAt: null });
  await PdfImportItem.create({ id: crypto.randomUUID(), batchId: b.id, fileName: 'performance.pdf', storedFilename: put.storedFilename, storageKind: put.storageKind, encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending' });
  const s = await drainPendingChunk({ maxItems: 5 });
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 0);
  const item = await PdfImportItem.findOne({ where: { batchId: b.id } });
  assert.equal(item?.status, 'skipped');
  assert.match(item?.reason ?? '', /No parser matched/i);
  const batch = await PdfImportBatch.findByPk(b.id);
  assert.equal(batch?.status, 'done');     // skipped-only batch is done, not failed
  assert.equal(batch?.skipped, 1);
  assert.ok(batch?.startedAt);             // started_at set
}

test('a no-parser file is skipped (not failed) with a reason', { skip: skipUnlessPrivateFixtures(PERFORMANCE_PDF) }, async () => {
  await assertNoParserFileIsSkipped(fs.readFileSync(PERFORMANCE_PDF));
});

test('a no-parser file is skipped (not failed) with a reason — synthetic PDF', async () => {
  await assertNoParserFileIsSkipped(synthPdf(SYN_UNRECOGNIZED));
});
