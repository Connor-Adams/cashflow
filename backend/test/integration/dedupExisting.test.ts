/**
 * Integration tests for NULL-as-wildcard pre-insert dedup
 * (the fix for re-importing the same Amex statement after Amex populates
 * a previously-missing Reference Number).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-dedup.sqlite');

let models: typeof import('../../src/models/index.js');
let findExistingForDedup: typeof import('../../src/import/dedupExisting.js').findExistingForDedup;
let rowFingerprint: typeof import('../../src/import/fingerprint.js').rowFingerprint;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });
  models = await import('../../src/models/index.js');
  findExistingForDedup = (await import('../../src/import/dedupExisting.js')).findExistingForDedup;
  rowFingerprint = (await import('../../src/import/fingerprint.js')).rowFingerprint;
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

async function seedTransaction(opts: {
  accountId: number;
  date: string;
  amount: number;
  merchantRaw: string;
  sourceReference: string | null;
}) {
  const fp = rowFingerprint({
    accountId: opts.accountId,
    date: opts.date,
    amount: opts.amount,
    currency: 'CAD',
    merchantRaw: opts.merchantRaw,
    sourceReference: opts.sourceReference,
  });
  return models.Transaction.create({
    accountId: opts.accountId,
    householdId: null,
    createdByUserId: null,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'dedup-test',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: String(opts.amount),
    currency: 'CAD',
    notes: null,
    sourceReference: opts.sourceReference,
    sourceRowFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: false,
    isRecurring: false,
  } as never);
}

async function makeAccount() {
  const acc = await models.Account.create({
    name: `Dedup Account ${Date.now()}-${Math.random()}`,
    owner: 'me',
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
  } as never);
  return acc;
}

test('NULL existing + populated incoming → backfills ref onto existing, no insert', async () => {
  const acc = await makeAccount();
  await seedTransaction({
    accountId: acc.id,
    date: '2026-02-22',
    amount: -15.24,
    merchantRaw: 'APPLE.COM/BILL          TORONTO',
    sourceReference: null,
  });

  const result = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId: acc.id,
      date: '2026-02-22',
      amount: -15.24,
      currency: 'CAD',
      merchantRaw: 'APPLE.COM/BILL          TORONTO',
      sourceReference: 'AT260530006000010179254',
      t,
    }),
  );

  assert.equal(result.kind, 'duplicate-backfilled');
  const all = await models.Transaction.findAll({ where: { accountId: acc.id } });
  assert.equal(all.length, 1, 'no new row inserted');
  assert.equal(all[0].sourceReference, 'AT260530006000010179254', 'existing row got ref backfilled');
  const expectedFp = rowFingerprint({
    accountId: acc.id,
    date: '2026-02-22',
    amount: -15.24,
    currency: 'CAD',
    merchantRaw: 'APPLE.COM/BILL          TORONTO',
    sourceReference: 'AT260530006000010179254',
  });
  assert.equal(all[0].sourceRowFingerprint, expectedFp, 'fingerprint recomputed with new ref');
});

test('populated existing + NULL incoming → duplicate, no insert', async () => {
  const acc = await makeAccount();
  await seedTransaction({
    accountId: acc.id,
    date: '2026-02-22',
    amount: -15.24,
    merchantRaw: 'APPLE.COM/BILL',
    sourceReference: 'AT260530006000010179254',
  });

  const result = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId: acc.id,
      date: '2026-02-22',
      amount: -15.24,
      currency: 'CAD',
      merchantRaw: 'APPLE.COM/BILL',
      sourceReference: null,
      t,
    }),
  );
  assert.equal(result.kind, 'duplicate');
  const all = await models.Transaction.findAll({ where: { accountId: acc.id } });
  assert.equal(all.length, 1);
});

test('exact src_ref match (both populated, same value) → duplicate', async () => {
  const acc = await makeAccount();
  await seedTransaction({
    accountId: acc.id,
    date: '2026-04-06',
    amount: -27.75,
    merchantRaw: 'WIFIONBOARD AIR CANADA  VANCOUVER',
    sourceReference: 'AT260960006000010158967',
  });

  const result = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId: acc.id,
      date: '2026-04-06',
      amount: -27.75,
      currency: 'CAD',
      merchantRaw: 'WIFIONBOARD AIR CANADA  VANCOUVER',
      sourceReference: 'AT260960006000010158967',
      t,
    }),
  );
  assert.equal(result.kind, 'duplicate');
});

test('two populated, different src_refs → no-match (preserves legit airline/Starbucks pairs)', async () => {
  const acc = await makeAccount();
  await seedTransaction({
    accountId: acc.id,
    date: '2025-12-08',
    amount: -25.0,
    merchantRaw: 'STARBUCKS 8007827282    800-782-7282',
    sourceReference: 'AT253420006000010162257',
  });

  const result = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId: acc.id,
      date: '2025-12-08',
      amount: -25.0,
      currency: 'CAD',
      merchantRaw: 'STARBUCKS 8007827282    800-782-7282',
      sourceReference: 'AT253420006000010162258',
      t,
    }),
  );
  assert.equal(result.kind, 'no-match', 'second legit charge must NOT be treated as a duplicate');
});

test('both NULL → duplicate (exact match path)', async () => {
  const acc = await makeAccount();
  await seedTransaction({
    accountId: acc.id,
    date: '2026-01-01',
    amount: -10.0,
    merchantRaw: 'CAFE NULL TEST',
    sourceReference: null,
  });

  const result = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId: acc.id,
      date: '2026-01-01',
      amount: -10.0,
      currency: 'CAD',
      merchantRaw: 'CAFE NULL TEST',
      sourceReference: null,
      t,
    }),
  );
  assert.equal(result.kind, 'duplicate');
});

test('fingerprint stable across normalizeMerchant drift: uses merchantRaw, not merchantClean', async () => {
  // Same bank-given merchant_raw must produce the same fingerprint regardless
  // of what merchantClean would be (which is normalizeMerchant's output).
  const fpA = rowFingerprint({
    accountId: 1,
    date: '2026-02-22',
    amount: -15.24,
    currency: 'CAD',
    merchantRaw: 'AMZN MKTP CA*HN75V23P3  866-216-1072',
    sourceReference: null,
  });
  const fpB = rowFingerprint({
    accountId: 1,
    date: '2026-02-22',
    amount: -15.24,
    currency: 'CAD',
    merchantRaw: 'AMZN MKTP CA*HN75V23P3  866-216-1072',
    sourceReference: null,
  });
  assert.equal(fpA, fpB);

  const fpDifferentMerchant = rowFingerprint({
    accountId: 1,
    date: '2026-02-22',
    amount: -15.24,
    currency: 'CAD',
    merchantRaw: 'AMZN MKTP CA*OTHER',
    sourceReference: null,
  });
  assert.notEqual(fpA, fpDifferentMerchant);
});
