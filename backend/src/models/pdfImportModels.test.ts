import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sequelize, PdfImportBatch, PdfImportItem, Household, User } from './';

test('pdf import batch + items persist and associate', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({
    email: 'a@b.c',
    displayName: 'Test User',
    passwordHash: 'x',
    passwordSalt: 'y',
    passwordParams: 'p',
  } as never);
  const batch = await PdfImportBatch.create({
    id: crypto.randomUUID(), householdId: hh.id, userId: u.id,
    status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0,
  });
  const item = await PdfImportItem.create({
    id: crypto.randomUUID(), batchId: batch.id, fileName: 'x.pdf',
    storedFilename: 'k.pdf', storageKind: 'local', encryptionAlgorithm: 'none', status: 'pending',
  });
  const found = await PdfImportItem.findOne({ where: { batchId: batch.id } });
  assert.equal(found?.id, item.id);
  assert.equal(found?.status, 'pending');
});
