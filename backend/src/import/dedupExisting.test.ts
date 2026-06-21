/**
 * Pending-promotion idempotency (sqlite-backed).
 *
 * Bug: `promotePending` flipped status (and backfilled sourceReference) but
 * left the row's pending-era `date` and `sourceIdentityFingerprint` in place.
 * The settled charge carries the posted date, so when a SECOND source later
 * presents the same settled transaction (CSV first, then the same statement
 * as PDF — the exact cross-format case the dedup chain exists for), every
 * tier missed:
 *   - identity-fingerprint lookup → fp was computed from the pending date
 *   - pending-window tier        → row is now status 'posted'
 *   - cross-parser drift tier    → requires exact date equality
 * and the formerly-pending charge was inserted a second time, double-counting
 * spend.
 *
 * The fix makes promotion adopt the incoming posted identity (date +
 * sourceIdentityFingerprint) so a re-presented settled charge hits the
 * fingerprint tier and dedup is idempotent.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../models/index.js');
let findExistingForDedup: typeof import('./dedupExisting.js').findExistingForDedup;
let stableIdentityFingerprint: typeof import('./fingerprint.js').stableIdentityFingerprint;

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  findExistingForDedup = (await import('./dedupExisting.js')).findExistingForDedup;
  stableIdentityFingerprint = (await import('./fingerprint.js')).stableIdentityFingerprint;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

const HOUSEHOLD_ID = 777;

async function makeAccount(): Promise<number> {
  const acc = await models.Account.create({
    name: `Pending Promo Card ${Date.now()}-${Math.random()}`,
    owner: 'me',
    householdId: HOUSEHOLD_ID,
    defaultCurrency: 'CAD',
    accountType: 'credit',
    visibility: 'private',
  } as never);
  return acc.id as number;
}

async function seedPending(opts: {
  accountId: number;
  date: string;
  amount: number;
  merchantRaw: string;
}): Promise<InstanceType<typeof models.Transaction>> {
  const identityFp = stableIdentityFingerprint({
    accountId: opts.accountId,
    date: opts.date,
    amount: opts.amount,
    currency: 'CAD',
    merchantRaw: opts.merchantRaw,
  });
  return models.Transaction.create({
    accountId: opts.accountId,
    householdId: HOUSEHOLD_ID,
    createdByUserId: null,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'pending-promo-test',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: String(opts.amount),
    currency: 'CAD',
    status: 'pending',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: `row-fp-${Math.random()}`,
    sourceIdentityFingerprint: identityFp,
    txnType: 'purchase',
    reviewFlag: false,
    isRecurring: false,
  } as never) as never;
}

test('promotion via the pending-window tier adopts the posted date + identity fingerprint', async () => {
  const accountId = await makeAccount();
  const pending = await seedPending({
    accountId,
    date: '2026-05-01',
    amount: -123.45,
    merchantRaw: 'HOTEL PENDING HOLD',
  });

  const postedFp = stableIdentityFingerprint({
    accountId,
    date: '2026-05-03',
    amount: -123.45,
    currency: 'CAD',
    merchantRaw: 'HOTEL PENDING HOLD',
  });
  const outcome = await models.sequelize.transaction((t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: postedFp,
      sourceReference: 'csv-ref-1',
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-05-03',
      incomingAmount: -123.45,
      incomingCurrency: 'CAD',
      incomingMerchantRaw: 'HOTEL PENDING HOLD',
    }),
  );
  assert.deepEqual(outcome, { kind: 'pending-promoted', existingId: pending.id });

  await pending.reload();
  assert.equal(pending.status, 'posted');
  assert.equal(pending.sourceReference, 'csv-ref-1');
  assert.equal(pending.date, '2026-05-03', 'promotion must adopt the settled (posted) date');
  assert.equal(
    pending.sourceIdentityFingerprint,
    postedFp,
    'promotion must adopt the posted identity fingerprint',
  );
});

test('dedup is idempotent after promotion: a second source re-presenting the settled charge is a duplicate', async () => {
  const accountId = await makeAccount();
  const pending = await seedPending({
    accountId,
    date: '2026-05-01',
    amount: -123.45,
    merchantRaw: 'HOTEL PENDING HOLD',
  });

  const postedFp = stableIdentityFingerprint({
    accountId,
    date: '2026-05-03',
    amount: -123.45,
    currency: 'CAD',
    merchantRaw: 'HOTEL PENDING HOLD',
  });
  const incoming = {
    accountId,
    sourceIdentityFingerprint: postedFp,
    incomingStatus: 'posted' as const,
    incomingDate: '2026-05-03',
    incomingAmount: -123.45,
    incomingCurrency: 'CAD',
    incomingMerchantRaw: 'HOTEL PENDING HOLD',
  };

  // First source (CSV): promotes the pending hold.
  const first = await models.sequelize.transaction((t) =>
    findExistingForDedup({ ...incoming, sourceReference: 'csv-ref-1', t }),
  );
  assert.deepEqual(first, { kind: 'pending-promoted', existingId: pending.id });

  // Second source (PDF, no source reference) presents the same settled charge.
  const second = await models.sequelize.transaction((t) =>
    findExistingForDedup({ ...incoming, sourceReference: null, t }),
  );
  assert.equal(
    second.kind,
    'duplicate',
    `re-presented settled charge must dedup, got '${second.kind}'`,
  );

  // Third source carrying the same reference is an exact duplicate too.
  const third = await models.sequelize.transaction((t) =>
    findExistingForDedup({ ...incoming, sourceReference: 'csv-ref-1', t }),
  );
  assert.equal(third.kind, 'duplicate', `same-ref re-import must dedup, got '${third.kind}'`);

  const count = await models.Transaction.count({ where: { accountId } });
  assert.equal(count, 1, 'the settled charge must exist exactly once');
});

test('pending-window promotion respects currency: a posted USD row does NOT promote a pending CAD row', async () => {
  // Currency-blind window tier bug: the pending-window tier matched on
  // accountId + status='pending' + date window + amount + merchantText but
  // NOT currency, so a posted row in one currency could promote/absorb a
  // pending hold in another currency with the same numeric amount + merchant.
  const accountId = await makeAccount();
  // Seed a pending hold in CAD (seedPending always uses CAD).
  await seedPending({
    accountId,
    date: '2026-05-01',
    amount: -123.45,
    merchantRaw: 'FX HOTEL HOLD',
  });

  // Incoming posted row carries the SAME amount + merchant but a DIFFERENT
  // currency (USD). Its fingerprint differs (currency is hashed in), so the
  // exact-fingerprint tier misses and it falls through to the window tier.
  const postedUsdFp = stableIdentityFingerprint({
    accountId,
    date: '2026-05-03',
    amount: -123.45,
    currency: 'USD',
    merchantRaw: 'FX HOTEL HOLD',
  });
  const outcome = await models.sequelize.transaction((t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: postedUsdFp,
      sourceReference: 'usd-ref-1',
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-05-03',
      incomingAmount: -123.45,
      incomingCurrency: 'USD',
      incomingMerchantRaw: 'FX HOTEL HOLD',
    }),
  );
  assert.equal(
    outcome.kind,
    'no-match',
    'a posted USD row must NOT promote a pending CAD hold of the same amount/merchant',
  );
});

test('promotion via the exact-fingerprint tier leaves the (already-correct) date untouched', async () => {
  const accountId = await makeAccount();
  // Pending row whose fingerprint already matches the incoming posted row
  // (same date — e.g. the hold settled same-day).
  const pending = await seedPending({
    accountId,
    date: '2026-05-07',
    amount: -55.0,
    merchantRaw: 'SAME DAY SETTLE',
  });
  const fp = pending.sourceIdentityFingerprint;

  const outcome = await models.sequelize.transaction((t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: fp,
      sourceReference: 'ref-9',
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-05-07',
      incomingAmount: -55.0,
      incomingCurrency: 'CAD',
      incomingMerchantRaw: 'SAME DAY SETTLE',
    }),
  );
  assert.deepEqual(outcome, { kind: 'pending-promoted', existingId: pending.id });
  await pending.reload();
  assert.equal(pending.status, 'posted');
  assert.equal(pending.date, '2026-05-07');
  assert.equal(pending.sourceIdentityFingerprint, fp);
});
