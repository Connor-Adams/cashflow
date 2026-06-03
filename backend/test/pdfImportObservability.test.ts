import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sequelize, PdfImportBatch, PdfImportItem, Household, User } from '../src/models';

async function hhUser() {
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({ email: 'a@b.c', householdId: hh.id, displayName: 'T', passwordHash: 'x', passwordSalt: 'y', passwordParams: 'p' } as never);
  return { hh, u };
}

test('batch has skipped + startedAt; item has reason; skipped status persists', async () => {
  await sequelize.sync({ force: true });
  const { hh, u } = await hhUser();
  const b = await PdfImportBatch.create({ id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0, skipped: 0, startedAt: null });
  const i = await PdfImportItem.create({ id: crypto.randomUUID(), batchId: b.id, fileName: 'x.pdf', storedFilename: 'k.pdf', storageKind: 'local', encryptionAlgorithm: 'none', status: 'skipped', reason: 'No parser matched this statement layout' });
  const got = await PdfImportItem.findByPk(i.id);
  assert.equal(got?.status, 'skipped');
  assert.equal(got?.reason, 'No parser matched this statement layout');
});
