import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sequelize, Account, Transaction, Receipt, Household } from '../models';
import { saveReceiptObject, isS3ReceiptStorageEnabled } from './receiptStorage';
import { getReceiptsUploadDir } from '../config/receipts';
import { deleteReceiptFilesForTransactions } from './receiptCleanup';

async function seed() {
  const household = await Household.create({ name: 'H' } as never);
  const account = await Account.create({
    householdId: household.id,
    name: 'Test Account',
  } as never);
  return { household, account };
}

async function makeTxn(householdId: number, accountId: number, tag: string) {
  return Transaction.create({
    householdId,
    accountId,
    date: '2026-06-10',
    amount: '-12.00',
    currency: 'CAD',
    merchantRaw: 'Store',
    merchantClean: 'Store',
    txnType: 'purchase',
    importBatch: 'test',
    sourceRowFingerprint: `srfp-${tag}`,
    sourceIdentityFingerprint: `sifp-${tag}`,
  } as never);
}

async function attachReceipt(transactionId: number, tag: string): Promise<string> {
  const storedFilename = `${crypto.randomUUID()}.bin`;
  const key = await saveReceiptObject(storedFilename, {
    buffer: Buffer.from(`pii-${tag}`),
    contentType: 'application/octet-stream',
    originalName: 'receipt.pdf',
  });
  await Receipt.create({
    transactionId,
    storedFilename: key,
    originalName: 'receipt.pdf',
    mimeType: 'application/octet-stream',
    sizeBytes: 4,
  } as never);
  return key;
}

function localPath(storedFilename: string): string {
  return path.join(getReceiptsUploadDir(), storedFilename);
}

test('deleteReceiptFilesForTransactions removes on-disk receipt files for the given transaction ids', async () => {
  // Local-disk storage path only (no S3 configured in unit tests).
  assert.equal(isS3ReceiptStorageEnabled(), false);
  await sequelize.sync({ force: true });
  const { household, account } = await seed();
  const txnA = await makeTxn(household.id, account.id, 'A');
  const txnB = await makeTxn(household.id, account.id, 'B');
  const keyA = await attachReceipt(txnA.id, 'A');
  const keyB = await attachReceipt(txnB.id, 'B');

  assert.ok(fs.existsSync(localPath(keyA)), 'file A should exist before cleanup');
  assert.ok(fs.existsSync(localPath(keyB)), 'file B should exist before cleanup');

  const deleted = await deleteReceiptFilesForTransactions([txnA.id, txnB.id]);

  assert.equal(deleted, 2);
  assert.ok(!fs.existsSync(localPath(keyA)), 'file A should be gone after cleanup');
  assert.ok(!fs.existsSync(localPath(keyB)), 'file B should be gone after cleanup');
});

test('deleteReceiptFilesForTransactions only touches the requested transactions', async () => {
  await sequelize.sync({ force: true });
  const { household, account } = await seed();
  const txnKeep = await makeTxn(household.id, account.id, 'keep');
  const txnDrop = await makeTxn(household.id, account.id, 'drop');
  const keyKeep = await attachReceipt(txnKeep.id, 'keep');
  const keyDrop = await attachReceipt(txnDrop.id, 'drop');

  const deleted = await deleteReceiptFilesForTransactions([txnDrop.id]);

  assert.equal(deleted, 1);
  assert.ok(fs.existsSync(localPath(keyKeep)), 'untargeted file must survive');
  assert.ok(!fs.existsSync(localPath(keyDrop)), 'targeted file must be deleted');
});

test('deleteReceiptFilesForTransactions tolerates a missing file (already gone)', async () => {
  await sequelize.sync({ force: true });
  const { household, account } = await seed();
  const txn = await makeTxn(household.id, account.id, 'missing');
  const key = await attachReceipt(txn.id, 'missing');
  // Simulate the blob already being gone (partial prior delete).
  fs.unlinkSync(localPath(key));

  // Must not throw even though the file is missing.
  const deleted = await deleteReceiptFilesForTransactions([txn.id]);
  assert.equal(deleted, 1);
});

test('deleteReceiptFilesForTransactions is a no-op for an empty id list', async () => {
  await sequelize.sync({ force: true });
  const deleted = await deleteReceiptFilesForTransactions([]);
  assert.equal(deleted, 0);
});
