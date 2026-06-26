import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import {
  sequelize,
  Account,
  Transaction,
  Receipt,
  User,
  Household,
  HouseholdMember,
  Session,
} from '../models';
import { hashPassword, hashToken } from '../auth/password';
import { saveReceiptObject } from '../storage/receiptStorage';
import { getReceiptsUploadDir } from '../config/receipts';

let testApp: (typeof import('../app.js'))['default'];
let sessionToken: string;
let householdId: number;
let userId: number;

before(async () => {
  await sequelize.sync({ force: true });

  const password = await hashPassword('password123');
  const user = await User.create({
    email: `acct-del-receipt-${Date.now()}@example.com`,
    displayName: 'Acct Del Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);
  userId = user.id;

  const household = await Household.create({ name: 'Acct Del HH' } as never);
  householdId = household.id;

  await HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  } as never);

  sessionToken = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  const { default: app } = await import('../app.js');
  testApp = app;
});

function localPath(storedFilename: string): string {
  return path.join(getReceiptsUploadDir(), storedFilename);
}

test('DELETE /api/accounts/:id removes on-disk receipt files of its transactions (#851)', async () => {
  const account = await Account.create({
    householdId,
    ownerUserId: userId,
    name: 'Card To Delete',
    visibility: 'shared',
  } as never);

  const txn = await Transaction.create({
    accountId: account.id,
    householdId,
    createdByUserId: userId,
    visibility: 'shared',
    importBatch: 'test-acct-del',
    date: '2026-06-01',
    amount: '-25.00',
    currency: 'CAD',
    merchantRaw: 'STORE',
    merchantClean: 'Store',
    sourceRowFingerprint: `acctdel-${Date.now()}`,
    sourceIdentityFingerprint: `acctdel-${Date.now()}`,
    txnType: 'purchase',
    finalSplitType: 'me',
  } as never);

  const storedFilename = `${crypto.randomUUID()}.bin`;
  const key = await saveReceiptObject(storedFilename, {
    buffer: Buffer.from('sensitive-pii-bytes'),
    contentType: 'application/octet-stream',
    originalName: 'id-document.pdf',
  });
  const receipt = await Receipt.create({
    transactionId: txn.id,
    storedFilename: key,
    originalName: 'id-document.pdf',
    mimeType: 'application/octet-stream',
    sizeBytes: 19,
  } as never);

  assert.ok(fs.existsSync(localPath(key)), 'receipt file should exist before account delete');

  const agent = request.agent(testApp);
  agent.jar.setCookie(`cashflow_session=${sessionToken}; Path=/`);
  const res = await agent.delete(`/api/accounts/${account.id}`);

  assert.equal(res.status, 204, `expected 204, got ${res.status}: ${JSON.stringify(res.body)}`);

  // The blob must be gone regardless of DB dialect. (Row-level cascade is the
  // DB's job — it fires on Postgres in prod; SQLite leaves FK enforcement off by
  // default, so this test asserts the storage cleanup our fix owns, not the SQL
  // cascade.)
  void receipt;
  assert.ok(
    !fs.existsSync(localPath(key)),
    'receipt file must be removed from storage — not orphaned (#851)',
  );
});
