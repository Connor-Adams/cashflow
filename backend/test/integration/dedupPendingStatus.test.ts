import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';
import { seedHousehold, type SeededHousehold } from '../helpers/seedHousehold.js';

let testDb: PgTestDb;
let models: typeof import('../../src/models/index.js');
let dedup: typeof import('../../src/import/dedupExisting.js');
let fingerprint: typeof import('../../src/import/fingerprint.js');
let household: SeededHousehold;

before(async () => {
  testDb = await setupPgTestDb('dedup_pending_status');
  models = await import('../../src/models/index.js');
  dedup = await import('../../src/import/dedupExisting.js');
  fingerprint = await import('../../src/import/fingerprint.js');
  household = await seedHousehold('DedupStatus', 'Dedup Status Partner');
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('dedup promotes matching pending transaction to posted instead of inserting duplicate', async () => {
  const account = await models.Account.create({
    name: 'Dedup Pending Card',
    owner: 'me',
    householdId: household.householdId,
    ownerUserId: household.userId,
    visibility: 'shared',
  });
  const identity = fingerprint.stableIdentityFingerprint({
    accountId: account.id,
    date: '2026-05-01',
    amount: -123.45,
    currency: 'CAD',
    merchantRaw: 'Hotel Pending Hold',
  });
  const pending = await models.Transaction.create({
    accountId: account.id,
    householdId: household.householdId,
    createdByUserId: household.userId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'pending-dedup',
    date: '2026-05-01',
    merchantRaw: 'Hotel Pending Hold',
    merchantClean: 'Hotel Pending Hold',
    amount: '-123.4500',
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: identity,
    finalSplitType: 'me',
    finalBusiness: false,
    myShareAmount: '-123.45',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    isRecurring: false,
    reviewFlag: false,
    status: 'pending',
  });

  const outcome = await models.sequelize.transaction((t) =>
    dedup.findExistingForDedup({
      accountId: account.id,
      sourceIdentityFingerprint: identity,
      sourceReference: 'posted-ref-1',
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-05-03',
      incomingAmount: -123.45,
      incomingMerchantRaw: 'Hotel Pending Hold',
    }),
  );

  assert.deepEqual(outcome, { kind: 'pending-promoted', existingId: pending.id });
  await pending.reload();
  assert.equal(pending.status, 'posted');
  assert.equal(pending.sourceReference, 'posted-ref-1');
});

test('dedup promotes pending hold when posted row has a different settled date fingerprint', async () => {
  const account = await models.Account.create({
    name: 'Dedup Date Drift Card',
    owner: 'me',
    householdId: household.householdId,
    ownerUserId: household.userId,
    visibility: 'shared',
  });
  const pendingIdentity = fingerprint.stableIdentityFingerprint({
    accountId: account.id,
    date: '2026-05-01',
    amount: -44.1,
    currency: 'CAD',
    merchantRaw: 'Coffee Hold',
  });
  const postedIdentity = fingerprint.stableIdentityFingerprint({
    accountId: account.id,
    date: '2026-05-03',
    amount: -44.1,
    currency: 'CAD',
    merchantRaw: 'Coffee Hold',
  });
  const pending = await models.Transaction.create({
    accountId: account.id,
    householdId: household.householdId,
    createdByUserId: household.userId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'pending-dedup-date-drift',
    date: '2026-05-01',
    merchantRaw: 'Coffee Hold',
    merchantClean: 'Coffee Hold',
    amount: '-44.1000',
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: pendingIdentity,
    finalSplitType: 'me',
    finalBusiness: false,
    myShareAmount: '-44.10',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    isRecurring: false,
    reviewFlag: false,
    status: 'pending',
  });

  const outcome = await models.sequelize.transaction((t) =>
    dedup.findExistingForDedup({
      accountId: account.id,
      sourceIdentityFingerprint: postedIdentity,
      sourceReference: 'posted-ref-2',
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-05-03',
      incomingAmount: -44.1,
      incomingMerchantRaw: 'Coffee Hold',
    }),
  );

  assert.deepEqual(outcome, { kind: 'pending-promoted', existingId: pending.id });
  await pending.reload();
  assert.equal(pending.status, 'posted');
  assert.equal(pending.sourceReference, 'posted-ref-2');
});
