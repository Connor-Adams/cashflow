/**
 * Cross-parser merchant-drift dedup (sqlite-backed).
 *
 * Bug: the same statement re-imported in a different format (CSV first, then
 * the Wealthsimple credit-card PDF parser) reconstructs `merchantRaw`
 * differently for some rows — e.g. "PIZZAVILLE #118" (CSV) vs
 * "PIZZAVILLE #1 18" (PDF), "DAIRY QUEEN #11989 GRI" vs
 * "DAIRY QUEEN #1 1989 GRI". Because `sourceIdentityFingerprint` hashes
 * merchantRaw, the two forms produce different fingerprints, so
 * `findExistingForDedup` misses and the row is inserted again — double-counting
 * the account balance (real impact: Wealthsimple Visa account 4, ~121 rows).
 *
 * The fix adds a final fallback tier in `findExistingForDedup` that, for posted
 * incoming rows, matches an existing posted row in the same account with the
 * same date/amount/currency whose merchant — after AGGRESSIVE normalization
 * (lowercase, strip all non-alphanumerics) — equals the incoming merchant's
 * aggressive-normalized form. "PIZZAVILLE #118" and "PIZZAVILLE #1 18" both
 * collapse to "pizzaville118"; "STARBUCKS" and "MCDONALDS" stay distinct.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('./index.js');
let findExistingForDedup: typeof import('../import/dedupExisting.js').findExistingForDedup;
let stableIdentityFingerprint: typeof import('../import/fingerprint.js').stableIdentityFingerprint;
let rowFingerprint: typeof import('../import/fingerprint.js').rowFingerprint;

before(async () => {
  models = await import('./index.js');
  await models.sequelize.sync({ force: true });
  findExistingForDedup = (await import('../import/dedupExisting.js')).findExistingForDedup;
  const fp = await import('../import/fingerprint.js');
  stableIdentityFingerprint = fp.stableIdentityFingerprint;
  rowFingerprint = fp.rowFingerprint;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

const HOUSEHOLD_ID = 4242;

async function makeAccount(): Promise<number> {
  const acc = await models.Account.create({
    name: `WS Visa ${Date.now()}-${Math.random()}`,
    owner: 'me',
    householdId: HOUSEHOLD_ID,
    defaultCurrency: 'CAD',
    accountType: 'credit',
    visibility: 'private',
  } as never);
  return acc.id as number;
}

async function seedPosted(opts: {
  accountId: number;
  date: string;
  amount: number;
  currency?: string;
  merchantRaw: string;
  merchantClean?: string;
  sourceReference?: string | null;
}): Promise<number> {
  const currency = opts.currency ?? 'CAD';
  const sourceReference = opts.sourceReference ?? null;
  const fp = rowFingerprint({
    accountId: opts.accountId,
    date: opts.date,
    amount: opts.amount,
    currency,
    merchantRaw: opts.merchantRaw,
    sourceReference,
  });
  const identityFp = stableIdentityFingerprint({
    accountId: opts.accountId,
    date: opts.date,
    amount: opts.amount,
    currency,
    merchantRaw: opts.merchantRaw,
  });
  const txn = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: HOUSEHOLD_ID,
    createdByUserId: null,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'cross-parser-test',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantClean ?? opts.merchantRaw,
    amount: String(opts.amount),
    currency,
    status: 'posted',
    notes: null,
    sourceReference,
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: identityFp,
    txnType: 'purchase',
    reviewFlag: false,
    isRecurring: false,
  } as never);
  return txn.id as number;
}

function identityFor(opts: {
  accountId: number;
  date: string;
  amount: number;
  currency?: string;
  merchantRaw: string;
}): string {
  return stableIdentityFingerprint({
    accountId: opts.accountId,
    date: opts.date,
    amount: opts.amount,
    currency: opts.currency ?? 'CAD',
    merchantRaw: opts.merchantRaw,
  });
}

// 1. RED: PIZZAVILLE #118 (CSV) vs PIZZAVILLE #1 18 (PDF) → duplicate.
test('cross-parser drift: "PIZZAVILLE #118" vs "PIZZAVILLE #1 18" → duplicate', async () => {
  const accountId = await makeAccount();
  const existingId = await seedPosted({
    accountId,
    date: '2026-03-01',
    amount: -18.42,
    merchantRaw: 'PIZZAVILLE #118',
    sourceReference: null,
  });

  // Incoming row uses a DIFFERENT merchantRaw → different identity fingerprint.
  const incomingMerchantRaw = 'PIZZAVILLE #1 18';
  const incomingFp = identityFor({
    accountId,
    date: '2026-03-01',
    amount: -18.42,
    merchantRaw: incomingMerchantRaw,
  });
  assert.notEqual(
    incomingFp,
    identityFor({ accountId, date: '2026-03-01', amount: -18.42, merchantRaw: 'PIZZAVILLE #118' }),
    'precondition: the two parser forms must produce different fingerprints',
  );

  const outcome = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: incomingFp,
      sourceReference: null,
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-03-01',
      incomingAmount: -18.42,
      incomingCurrency: 'CAD',
      incomingMerchantRaw,
    }),
  );

  assert.ok(
    outcome.kind === 'duplicate' || outcome.kind === 'duplicate-backfilled',
    `expected a duplicate outcome, got '${outcome.kind}'`,
  );
  if (outcome.kind !== 'no-match') {
    assert.equal(outcome.existingId, existingId);
  }
});

// 2. DAIRY QUEEN #11989 GRI vs DAIRY QUEEN #1 1989 GRI → duplicate.
test('cross-parser drift: "DAIRY QUEEN #11989 GRI" vs "DAIRY QUEEN #1 1989 GRI" → duplicate', async () => {
  const accountId = await makeAccount();
  const existingId = await seedPosted({
    accountId,
    date: '2026-03-02',
    amount: -9.13,
    merchantRaw: 'DAIRY QUEEN #11989 GRI',
    sourceReference: null,
  });

  const incomingMerchantRaw = 'DAIRY QUEEN #1 1989 GRI';
  const incomingFp = identityFor({
    accountId,
    date: '2026-03-02',
    amount: -9.13,
    merchantRaw: incomingMerchantRaw,
  });

  const outcome = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: incomingFp,
      sourceReference: null,
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-03-02',
      incomingAmount: -9.13,
      incomingCurrency: 'CAD',
      incomingMerchantRaw,
    }),
  );

  assert.ok(
    outcome.kind === 'duplicate' || outcome.kind === 'duplicate-backfilled',
    `expected a duplicate outcome, got '${outcome.kind}'`,
  );
  if (outcome.kind !== 'no-match') {
    assert.equal(outcome.existingId, existingId);
  }
});

// 2b. The fallback should also fire when the existing row's drift lives in
// merchantClean (parsers sometimes only diverge after normalization).
test('cross-parser drift matches against existing.merchantClean too', async () => {
  const accountId = await makeAccount();
  const existingId = await seedPosted({
    accountId,
    date: '2026-03-03',
    amount: -4.5,
    merchantRaw: 'SOME RAW STRING THAT DIFFERS',
    merchantClean: 'TIM HORTONS #2 345',
    sourceReference: null,
  });

  const incomingMerchantRaw = 'TIM HORTONS #2345';
  const outcome = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: identityFor({
        accountId,
        date: '2026-03-03',
        amount: -4.5,
        merchantRaw: incomingMerchantRaw,
      }),
      sourceReference: null,
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-03-03',
      incomingAmount: -4.5,
      incomingCurrency: 'CAD',
      incomingMerchantRaw,
    }),
  );

  assert.ok(
    outcome.kind === 'duplicate' || outcome.kind === 'duplicate-backfilled',
    `expected a duplicate outcome, got '${outcome.kind}'`,
  );
  if (outcome.kind !== 'no-match') {
    assert.equal(outcome.existingId, existingId);
  }
});

// 3. Negative/guard: genuinely different merchants same date+amount → no-match.
test('guard: different merchants ("STARBUCKS" vs "MCDONALDS") same date+amount → no-match', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId,
    date: '2026-03-04',
    amount: -10.0,
    merchantRaw: 'STARBUCKS',
    sourceReference: null,
  });

  const incomingMerchantRaw = 'MCDONALDS';
  const outcome = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: identityFor({
        accountId,
        date: '2026-03-04',
        amount: -10.0,
        merchantRaw: incomingMerchantRaw,
      }),
      sourceReference: null,
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-03-04',
      incomingAmount: -10.0,
      incomingCurrency: 'CAD',
      incomingMerchantRaw,
    }),
  );

  assert.equal(outcome.kind, 'no-match', 'distinct merchants must not be collapsed');
});

// 4a. Guard: same merchant, different amount → no-match.
test('guard: same merchant, different amount → no-match', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId,
    date: '2026-03-05',
    amount: -18.42,
    merchantRaw: 'PIZZAVILLE #118',
    sourceReference: null,
  });

  const incomingMerchantRaw = 'PIZZAVILLE #1 18';
  const outcome = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: identityFor({
        accountId,
        date: '2026-03-05',
        amount: -99.99,
        merchantRaw: incomingMerchantRaw,
      }),
      sourceReference: null,
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-03-05',
      incomingAmount: -99.99,
      incomingCurrency: 'CAD',
      incomingMerchantRaw,
    }),
  );

  assert.equal(outcome.kind, 'no-match', 'different amount must not be collapsed');
});

// 4b. Guard: same merchant, different date → no-match.
test('guard: same merchant+amount, different date → no-match', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId,
    date: '2026-03-06',
    amount: -18.42,
    merchantRaw: 'PIZZAVILLE #118',
    sourceReference: null,
  });

  const incomingMerchantRaw = 'PIZZAVILLE #1 18';
  const outcome = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: identityFor({
        accountId,
        date: '2026-03-07',
        amount: -18.42,
        merchantRaw: incomingMerchantRaw,
      }),
      sourceReference: null,
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-03-07',
      incomingAmount: -18.42,
      incomingCurrency: 'CAD',
      incomingMerchantRaw,
    }),
  );

  assert.equal(outcome.kind, 'no-match', 'different date must not be collapsed');
});

// 4c. Guard: same merchant+date+amount but different currency → no-match.
test('guard: same merchant+date+amount, different currency → no-match', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId,
    date: '2026-03-08',
    amount: -18.42,
    currency: 'USD',
    merchantRaw: 'PIZZAVILLE #118',
    sourceReference: null,
  });

  const incomingMerchantRaw = 'PIZZAVILLE #1 18';
  const outcome = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: identityFor({
        accountId,
        date: '2026-03-08',
        amount: -18.42,
        currency: 'CAD',
        merchantRaw: incomingMerchantRaw,
      }),
      sourceReference: null,
      t,
      incomingStatus: 'posted',
      incomingDate: '2026-03-08',
      incomingAmount: -18.42,
      incomingCurrency: 'CAD',
      incomingMerchantRaw,
    }),
  );

  assert.equal(outcome.kind, 'no-match', 'different currency must not be collapsed');
});

// 5. Guard: the fallback only applies to posted incoming rows.
test('guard: pending incoming does not trigger the cross-parser fallback', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId,
    date: '2026-03-09',
    amount: -18.42,
    merchantRaw: 'PIZZAVILLE #118',
    sourceReference: null,
  });

  const incomingMerchantRaw = 'PIZZAVILLE #1 18';
  const outcome = await models.sequelize.transaction(async (t) =>
    findExistingForDedup({
      accountId,
      sourceIdentityFingerprint: identityFor({
        accountId,
        date: '2026-03-09',
        amount: -18.42,
        merchantRaw: incomingMerchantRaw,
      }),
      sourceReference: null,
      t,
      incomingStatus: 'pending',
      incomingDate: '2026-03-09',
      incomingAmount: -18.42,
      incomingCurrency: 'CAD',
      incomingMerchantRaw,
    }),
  );

  assert.equal(outcome.kind, 'no-match', 'pending rows must not use the posted-only fallback');
});
