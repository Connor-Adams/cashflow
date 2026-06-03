/**
 * Integration tests for stable-identity pre-insert dedup
 * (the fix for re-importing the same Amex statement after Amex populates
 * a previously-missing Reference Number, AND for normalizeMerchant drift).
 *
 * Dedup now keys on `sourceIdentityFingerprint` — a hash over
 * accountId+date+amount+currency+merchantRaw — instead of the row
 * fingerprint, which used merchantClean+sourceReference (both unstable).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let models: typeof import('../../src/models/index.js');
let findExistingForDedup: typeof import('../../src/import/dedupExisting.js').findExistingForDedup;
let rowFingerprint: typeof import('../../src/import/fingerprint.js').rowFingerprint;
let stableIdentityFingerprint: typeof import('../../src/import/fingerprint.js').stableIdentityFingerprint;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('dedup');
  models = await import('../../src/models/index.js');
  const fp = await import('../../src/import/fingerprint.js');
  findExistingForDedup = (await import('../../src/import/dedupExisting.js')).findExistingForDedup;
  rowFingerprint = fp.rowFingerprint;
  stableIdentityFingerprint = fp.stableIdentityFingerprint;
});

after(async () => {
  await models?.sequelize.close();
  await teardownPgTestDb(testDb);
});

async function seedTransaction(opts: {
  accountId: number;
  date: string;
  amount: number;
  merchantRaw: string;
  sourceReference: string | null;
  merchantClean?: string;
}) {
  const fp = rowFingerprint({
    accountId: opts.accountId,
    date: opts.date,
    amount: opts.amount,
    currency: 'CAD',
    merchantRaw: opts.merchantRaw,
    sourceReference: opts.sourceReference,
  });
  const identityFp = stableIdentityFingerprint({
    accountId: opts.accountId,
    date: opts.date,
    amount: opts.amount,
    currency: 'CAD',
    merchantRaw: opts.merchantRaw,
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
    merchantClean: opts.merchantClean ?? opts.merchantRaw,
    amount: String(opts.amount),
    currency: 'CAD',
    notes: null,
    sourceReference: opts.sourceReference,
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: identityFp,
    txnType: 'purchase',
    reviewFlag: false,
    isRecurring: false,
  } as never);
}

async function makeAccount() {
  // Account needs a household so the beforeCreate hook fills entity_id
  // (NOT NULL since migration 20260619000001). Dedup itself is account-scoped
  // (findExistingForDedup keys on accountId + sourceIdentityFingerprint), so
  // the household is irrelevant to what these tests exercise.
  const household = await models.Household.create({
    name: `Dedup HH ${Date.now()}-${Math.random()}`,
  });
  const acc = await models.Account.create({
    name: `Dedup Account ${Date.now()}-${Math.random()}`,
    owner: 'me',
    householdId: household.id,
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
  } as never);
  return acc;
}

function identityFor(opts: {
  accountId: number;
  date: string;
  amount: number;
  merchantRaw: string;
}): string {
  return stableIdentityFingerprint({
    accountId: opts.accountId,
    date: opts.date,
    amount: opts.amount,
    currency: 'CAD',
    merchantRaw: opts.merchantRaw,
  });
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
      sourceIdentityFingerprint: identityFor({
        accountId: acc.id,
        date: '2026-02-22',
        amount: -15.24,
        merchantRaw: 'APPLE.COM/BILL          TORONTO',
      }),
      sourceReference: 'AT260530006000010179254',
      t,
    }),
  );

  assert.equal(result.kind, 'duplicate-backfilled');
  const all = await models.Transaction.findAll({ where: { accountId: acc.id } });
  assert.equal(all.length, 1, 'no new row inserted');
  assert.equal(
    all[0].sourceReference,
    'AT260530006000010179254',
    'existing row got ref backfilled',
  );
});

test('backfill arm: sourceRowFingerprint preserved, only sourceReference updated', async () => {
  // Verifies the scoped save: when an Amex ref flips NULL → AT…, we ONLY
  // write the sourceReference column. The legacy `sourceRowFingerprint`
  // stays as the null-era hash (audit-only field). Rewriting it would risk
  // colliding with the unique safety-net index and is unnecessary because
  // dedup is now keyed by `sourceIdentityFingerprint`.
  const acc = await makeAccount();
  const seeded = await seedTransaction({
    accountId: acc.id,
    date: '2026-02-22',
    amount: -42.0,
    merchantRaw: 'STARLINK INTERNET CA',
    sourceReference: null,
  });
  const originalFp = seeded.sourceRowFingerprint;

  const result = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId: acc.id,
      sourceIdentityFingerprint: identityFor({
        accountId: acc.id,
        date: '2026-02-22',
        amount: -42.0,
        merchantRaw: 'STARLINK INTERNET CA',
      }),
      sourceReference: 'AT26999BACKFILL',
      t,
    }),
  );

  assert.equal(result.kind, 'duplicate-backfilled');
  const all = await models.Transaction.findAll({ where: { accountId: acc.id } });
  assert.equal(all.length, 1);
  assert.equal(all[0].sourceReference, 'AT26999BACKFILL');
  assert.equal(
    all[0].sourceRowFingerprint,
    originalFp,
    'sourceRowFingerprint must NOT be rewritten on backfill',
  );
});

test('normalizeMerchant rule change does not affect dedup identity', async () => {
  // Same merchantRaw → same identity fingerprint regardless of merchantClean.
  // This is the property that fixes re-imports after normalizeMerchant
  // evolves: the dedup key is computed from bank-stable fields only.
  const acc = await makeAccount();
  await seedTransaction({
    accountId: acc.id,
    date: '2026-03-15',
    amount: -7.99,
    merchantRaw: 'SQ *COFFEE SHOP        TORONTO',
    sourceReference: 'AT26010CLEAN',
    merchantClean: 'COFFEE SHOP', // imagine the OLD normalizeMerchant produced this
  });

  // Re-import: normalizeMerchant has since been improved to also strip the
  // city suffix, so merchantClean would now be just "COFFEE". But
  // merchantRaw is unchanged (bank-provided), so identity matches.
  const result = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId: acc.id,
      sourceIdentityFingerprint: identityFor({
        accountId: acc.id,
        date: '2026-03-15',
        amount: -7.99,
        merchantRaw: 'SQ *COFFEE SHOP        TORONTO',
      }),
      sourceReference: 'AT26010CLEAN',
      t,
    }),
  );

  assert.equal(result.kind, 'duplicate');
  const all = await models.Transaction.findAll({ where: { accountId: acc.id } });
  assert.equal(all.length, 1, 'normalizeMerchant drift must not cause re-import dup');
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
      sourceIdentityFingerprint: identityFor({
        accountId: acc.id,
        date: '2026-02-22',
        amount: -15.24,
        merchantRaw: 'APPLE.COM/BILL',
      }),
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
      sourceIdentityFingerprint: identityFor({
        accountId: acc.id,
        date: '2026-04-06',
        amount: -27.75,
        merchantRaw: 'WIFIONBOARD AIR CANADA  VANCOUVER',
      }),
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
      sourceIdentityFingerprint: identityFor({
        accountId: acc.id,
        date: '2025-12-08',
        amount: -25.0,
        merchantRaw: 'STARBUCKS 8007827282    800-782-7282',
      }),
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
      sourceIdentityFingerprint: identityFor({
        accountId: acc.id,
        date: '2026-01-01',
        amount: -10.0,
        merchantRaw: 'CAFE NULL TEST',
      }),
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
