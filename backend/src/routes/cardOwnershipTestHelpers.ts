/**
 * Shared DB-seeding helpers for the cardOwnership test suite
 * (items.test.ts, receiptsCardOwnership.test.ts, cardOwnershipConsistency.test.ts).
 *
 * Each of those files bootstraps its own per-process SQLite `models` module
 * (dynamically imported inside `before()`, after DATABASE_PATH is set) and
 * its own mutable `household`, so these are plain functions parameterized by
 * both rather than closures — `models` cannot be imported statically here
 * without loading it before the test file sets DATABASE_PATH.
 */
import crypto from 'crypto';

type Models = typeof import('../models');

/** Returns a `fp()` generator producing unique, prefixed fingerprint strings. */
export function createFingerprinter(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `fp-${prefix}-${counter}-${crypto.randomBytes(4).toString('hex')}`;
  };
}

export async function makeCardOwnershipAccount(
  models: Models,
  householdId: number,
  shortCode: string | null,
) {
  return models.Account.create({
    householdId,
    owner: 'me',
    visibility: 'shared',
    name: `Account ${shortCode ?? 'none'}`,
    accountType: 'credit_card',
    shortCode,
  } as never);
}

export async function makeAmazonOrder(
  models: Models,
  householdId: number,
  vendor: string,
  paymentLast4: string | null,
  dedupeKey: string,
) {
  return models.ExternalOrder.create({
    householdId,
    vendor,
    dedupeKey,
    orderDate: '2026-06-01',
    total: '50.00',
    subtotal: '50.00',
    currency: 'CAD',
    paymentLast4,
    source: 'test',
  } as never);
}

/** A generic Amazon-merchant transaction, used across these suites as the
 * "known account, real charge" fixture that a TransactionOrderLink or
 * Receipt then points at. */
export async function makeAmazonTransaction(
  models: Models,
  householdId: number,
  accountId: number,
  fp: () => string,
) {
  return models.Transaction.create({
    accountId,
    householdId,
    importBatch: 'test',
    date: '2026-06-01',
    merchantRaw: 'AMZN MKTP CA',
    merchantClean: 'Amazon',
    amount: '-50.00',
    currency: 'CAD',
    sourceRowFingerprint: fp(),
    sourceIdentityFingerprint: fp(),
    visibility: 'shared',
    ownershipType: 'shared',
    finalCategory: null,
    finalBusiness: false,
    finalSplitType: 'none',
    businessAmount: '0',
  } as never);
}
