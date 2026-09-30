/**
 * Cross-source NARRATIVE RENAME dedup (sqlite-backed).
 *
 * Prod bug found 2026-09-29: import_batch '2026-06 WK3DD9X35CAD' re-imported
 * Wealthsimple rows dated 2026-02-05→03-27 that batch '2026-05 WK3DD9X35CAD'
 * already held, and the two sources word the same cash event completely
 * differently — the same charge is "Pre-authorized Debit to AMEX BILL PYMT" in
 * one export and "Cash correction (executed at ...)" in the other. 48 rows got
 * in, inflating Feb–Mar 2026 income AND spend by ~$20k each.
 *
 * Every tier of `findExistingForDedup` is anchored on the merchant text except
 * the bank-reference tier (which needs a `source_reference` Wealthsimple does
 * not supply). Even the cross-parser drift tier only survives *punctuation*
 * drift — it compares `aggressiveMerchantKey`, so two unrelated strings miss.
 *
 * So dedup needs one more tier that ignores the merchant text entirely. It must
 * not become a false-positive machine: two genuinely distinct $40 charges on the
 * same card on the same day are two rows, not one. The tier is therefore
 * AMBIGUITY-GATED — it acts only when the (account, date, amount, currency) key
 * identifies exactly ONE unconsumed existing row, and refuses to guess
 * otherwise. Refusing leaves a recoverable duplicate; guessing wrong destroys a
 * real transaction, so the asymmetry decides it.
 *
 * Mirrors `fuzzyDedupInvestmentActivity`'s multi-match + consume-once design,
 * which already solved this for `investment_activities`.
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

const HOUSEHOLD_ID = 901;

async function makeAccount(): Promise<number> {
  const acc = await models.Account.create({
    name: `WS Chequing ${Date.now()}-${Math.random()}`,
    owner: 'me',
    householdId: HOUSEHOLD_ID,
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
    shortCode: 'WK3DD9X35CAD',
  } as never);
  return acc.id as number;
}

async function seedPosted(opts: {
  accountId: number;
  date: string;
  amount: number;
  merchantRaw: string;
  currency?: string;
  sourceReference?: string | null;
  importBatch?: string;
}): Promise<InstanceType<typeof models.Transaction>> {
  const currency = opts.currency ?? 'CAD';
  return models.Transaction.create({
    accountId: opts.accountId,
    householdId: HOUSEHOLD_ID,
    createdByUserId: null,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: opts.importBatch ?? '2026-05 WK3DD9X35CAD',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: String(opts.amount),
    currency,
    status: 'posted',
    notes: null,
    sourceReference: opts.sourceReference ?? null,
    sourceRowFingerprint: `row-fp-${Math.random()}`,
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId: opts.accountId,
      date: opts.date,
      amount: opts.amount,
      currency,
      merchantRaw: opts.merchantRaw,
    }),
    txnType: 'transfer',
    reviewFlag: false,
    isRecurring: false,
  } as never) as never;
}

/** The incoming row as the 2026-06 re-import presents it. */
function incoming(opts: {
  accountId: number;
  date: string;
  amount: number;
  merchantRaw: string;
  currency?: string;
  sourceReference?: string | null;
  consumedExistingIds?: Set<number>;
  t: import('sequelize').Transaction;
}) {
  const currency = opts.currency ?? 'CAD';
  return {
    accountId: opts.accountId,
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId: opts.accountId,
      date: opts.date,
      amount: opts.amount,
      currency,
      merchantRaw: opts.merchantRaw,
    }),
    sourceReference: opts.sourceReference ?? null,
    t: opts.t,
    incomingStatus: 'posted' as const,
    incomingDate: opts.date,
    incomingAmount: opts.amount,
    incomingCurrency: currency,
    incomingMerchantRaw: opts.merchantRaw,
    consumedExistingIds: opts.consumedExistingIds,
  };
}

test('a re-import that renames the narrative entirely is a duplicate, not a new row', async () => {
  const accountId = await makeAccount();
  const original = await seedPosted({
    accountId,
    date: '2026-02-05',
    amount: -11922.9,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      incoming({
        accountId,
        date: '2026-02-05',
        amount: -11922.9,
        merchantRaw: 'Cash correction (executed at 2026-02-05)',
        t,
      }),
    );
    assert.deepEqual(outcome, { kind: 'duplicate', existingId: original.id });
  });
});

test('two existing rows sharing the key are ambiguous: decline rather than guess', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId, date: '2026-02-05', amount: -40, merchantRaw: 'STARBUCKS #123',
  });
  await seedPosted({
    accountId, date: '2026-02-05', amount: -40, merchantRaw: 'MCDONALDS #99',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      incoming({
        accountId, date: '2026-02-05', amount: -40, merchantRaw: 'Cash correction', t,
      }),
    );
    assert.deepEqual(outcome, { kind: 'no-match' });
  });
});

test('a consumed existing row is not absorbed twice: the second incoming row inserts', async () => {
  const accountId = await makeAccount();
  const original = await seedPosted({
    accountId, date: '2026-02-05', amount: -40, merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
  });

  await models.sequelize.transaction(async (t) => {
    const consumed = new Set<number>();
    const first = await findExistingForDedup(
      incoming({
        accountId, date: '2026-02-05', amount: -40,
        merchantRaw: 'Cash correction', consumedExistingIds: consumed, t,
      }),
    );
    assert.deepEqual(first, { kind: 'duplicate', existingId: original.id });
    consumed.add(original.id);

    const second = await findExistingForDedup(
      incoming({
        accountId, date: '2026-02-05', amount: -40,
        merchantRaw: 'Withdrawal', consumedExistingIds: consumed, t,
      }),
    );
    assert.deepEqual(second, { kind: 'no-match' });
  });
});

test('a different amount on the same day is not a duplicate', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId, date: '2026-02-05', amount: -40, merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      incoming({ accountId, date: '2026-02-05', amount: -41, merchantRaw: 'Cash correction', t }),
    );
    assert.deepEqual(outcome, { kind: 'no-match' });
  });
});

test('a different currency on the same day and amount is not a duplicate', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId, date: '2026-02-05', amount: -40, currency: 'USD',
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      incoming({
        accountId, date: '2026-02-05', amount: -40, currency: 'CAD',
        merchantRaw: 'Cash correction', t,
      }),
    );
    assert.deepEqual(outcome, { kind: 'no-match' });
  });
});

test('two populated but differing bank references stay distinct charges', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId, date: '2026-02-05', amount: -40,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT', sourceReference: 'REF-AAA',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      incoming({
        accountId, date: '2026-02-05', amount: -40,
        merchantRaw: 'Cash correction', sourceReference: 'REF-BBB', t,
      }),
    );
    assert.deepEqual(outcome, { kind: 'no-match' });
  });
});

/**
 * THE HOLE in an ambiguity-gate that only counts EXISTING candidates.
 *
 * Two genuinely distinct $5 charges on one card on one day — a real and common
 * shape. The first is already imported. The second arrives on a later import and
 * is a NEW transaction, not a re-import. But (account, date, amount, currency)
 * matches exactly one existing row, so the gate is satisfied and tier 5 absorbs
 * a real transaction into an unrelated one. That is the silent-data-loss mode
 * the gate was supposed to prevent: the gate guards against several existing
 * candidates, never against the incoming row being genuinely new.
 *
 * The signal that separates the two cases is that a renamed row's narrative is
 * GENERIC — "Cash correction", "Withdrawal", "Deposit" carry no merchant
 * identity, they are statement bookkeeping labels. Two specific merchants
 * ("STARBUCKS #123" vs "MCDONALDS #99") never describe one event. So tier 5 must
 * additionally require that at least one side of the pair is a generic
 * statement narrative.
 */
test('two specific merchants never collapse: a real same-day same-amount charge survives', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId, date: '2026-02-05', amount: -5, merchantRaw: 'STARBUCKS #123',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      incoming({ accountId, date: '2026-02-05', amount: -5, merchantRaw: 'MCDONALDS #99', t }),
    );
    assert.deepEqual(outcome, { kind: 'no-match' });
  });
});

/**
 * Live dedup stays on an EXACT date match: the ±1-day variant of this shape is
 * real in prod (a settlement-vs-execution offset on the WS deposit-ledger
 * cleanup) but loosening the tier to catch it would also collapse two genuine
 * consecutive-day withdrawals of equal size, which on a deposit account carry
 * generic narratives on BOTH sides and so satisfy the gate. Instead the tier
 * reports the near-miss so the import can warn about it, and a supervised
 * cleanup pass resolves the existing rows.
 */
test('a one-day-offset generic near-match is reported, not deduped', async () => {
  const accountId = await makeAccount();
  const existing = await seedPosted({
    accountId, date: '2026-03-13', amount: -1000, merchantRaw: 'Withdrawal',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      incoming({
        accountId, date: '2026-03-14', amount: -1000,
        merchantRaw: 'Cash correction (executed at 2026-03-14)', t,
      }),
    );
    assert.equal(outcome.kind, 'no-match', 'must NOT dedup across a date shift');
    assert.deepEqual(
      outcome.kind === 'no-match' ? outcome.nearMissCandidateIds : undefined,
      [existing.id],
      'but the near-miss must be reported so the import can warn',
    );
  });
});

test('a one-day-offset near-match between two SPECIFIC merchants is not even reported', async () => {
  const accountId = await makeAccount();
  await seedPosted({
    accountId, date: '2026-03-13', amount: -1000, merchantRaw: 'STARBUCKS #123',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      incoming({ accountId, date: '2026-03-14', amount: -1000, merchantRaw: 'MCDONALDS #99', t }),
    );
    assert.deepEqual(outcome, { kind: 'no-match' });
  });
});
