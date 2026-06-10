/**
 * Colocated unit tests for `detectMonthlyCloseCritical`'s outstanding-
 * partner-balance detector.
 *
 * The detector must agree with the production fairness math in
 * `summary/partnerMath.ts`: per (contact, currency) bucket,
 *
 *   net = rawNet(shared spend) + settledAmount(iPaid − partnerPaid)
 *
 * computed from the start of time through period_end. Two failure modes
 * are pinned here because each one was a real bug when the detector
 * summed settlement rows alone:
 *
 *  - FALSE NEGATIVE: unsettled shared spend with zero settlement rows
 *    must still warn (that is the scenario the warning exists for);
 *  - PERMANENT FALSE POSITIVE: a one-directional settlement that fully
 *    squares the balance must NOT warn forever after.
 *
 * Uses the per-process SQLite test DB (backend/test/setup.ts).
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  sequelize,
  Account,
  Contact,
  Household,
  PartnerSettlement,
  Transaction,
} from '../models';
import { detectMonthlyCloseCritical } from './monthlyCloseCritical';

let accountId: number;

/** Each test gets its own household so buckets never bleed across tests. */
async function createHousehold(name: string): Promise<{
  householdId: number;
  contactId: number;
}> {
  const household = await Household.create({ name } as never);
  const contact = await Contact.create({
    householdId: household.id,
    name: `${name} Partner`,
    isPartner: true,
  } as never);
  return { householdId: household.id, contactId: contact.id };
}

async function createSharedTxn(opts: {
  householdId: number;
  contactId: number | null;
  date: string;
  amount: number;
  partnerShare: number;
  currency?: string;
}): Promise<void> {
  const fp = crypto.randomBytes(16).toString('hex');
  await Transaction.create({
    accountId,
    householdId: opts.householdId,
    visibility: 'shared',
    importBatch: 'monthly-close-critical-test',
    date: opts.date,
    amount: opts.amount.toFixed(4),
    currency: opts.currency ?? 'CAD',
    merchantRaw: 'Shared Merchant',
    merchantClean: 'Shared Merchant',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: false,
    ownershipType: 'shared_50_50',
    ownershipContactId: opts.contactId,
    finalSplitType: 'shared_50_50',
    myShareAmount: (opts.amount - opts.partnerShare).toFixed(4),
    partnerShareAmount: opts.partnerShare.toFixed(4),
  } as never);
}

before(async () => {
  await sequelize.sync({ force: true });
  const base = await Household.create({ name: 'Account Holder HH' } as never);
  const account = await Account.create({
    householdId: base.id,
    name: 'Shared Card',
    accountType: 'credit_card',
    visibility: 'shared',
    defaultCurrency: 'CAD',
  } as never);
  accountId = account.id;
});

test('unsettled shared spend with zero settlement rows flags the bucket', async () => {
  const { householdId, contactId } = await createHousehold('FalseNegative');
  // Partner owes their -500 share of a 1000 purchase I paid; no settlements.
  await createSharedTxn({
    householdId,
    contactId,
    date: '2026-03-10',
    amount: -1000,
    partnerShare: -500,
  });
  const result = await detectMonthlyCloseCritical({ householdId }, '2026-03');
  assert.equal(result.counts.outstandingPartnerBuckets, 1);
  assert.ok(result.reasons.includes('outstanding_partner_balance'));
  assert.equal(result.hasCritical, true);
});

test('a one-directional settlement that squares the balance does not flag', async () => {
  const { householdId, contactId } = await createHousehold('FalsePositive');
  // Partner owed me 500 (their share of spend I paid), then paid me 500.
  await createSharedTxn({
    householdId,
    contactId,
    date: '2026-03-05',
    amount: -1000,
    partnerShare: -500,
  });
  await PartnerSettlement.create({
    householdId,
    contactId,
    direction: 'partner_paid_me',
    currency: 'CAD',
    amount: '500.0000',
    settledDate: '2026-03-20',
  } as never);
  const result = await detectMonthlyCloseCritical({ householdId }, '2026-03');
  assert.equal(result.counts.outstandingPartnerBuckets, 0);
  assert.ok(!result.reasons.includes('outstanding_partner_balance'));
});

test('a partially settled balance still flags', async () => {
  const { householdId, contactId } = await createHousehold('PartialSettle');
  await createSharedTxn({
    householdId,
    contactId,
    date: '2026-03-08',
    amount: -1000,
    partnerShare: -500,
  });
  await PartnerSettlement.create({
    householdId,
    contactId,
    direction: 'partner_paid_me',
    currency: 'CAD',
    amount: '200.0000',
    settledDate: '2026-03-25',
  } as never);
  const result = await detectMonthlyCloseCritical({ householdId }, '2026-03');
  assert.equal(result.counts.outstandingPartnerBuckets, 1);
});

test('spend and settlements after period_end are excluded from the running balance', async () => {
  const { householdId, contactId } = await createHousehold('AfterPeriod');
  await createSharedTxn({
    householdId,
    contactId,
    date: '2026-04-05',
    amount: -1000,
    partnerShare: -500,
  });
  const result = await detectMonthlyCloseCritical({ householdId }, '2026-03');
  assert.equal(result.counts.outstandingPartnerBuckets, 0);
  assert.equal(result.hasCritical, false);
});

test('clean household reports zero buckets', async () => {
  const { householdId } = await createHousehold('Clean');
  const result = await detectMonthlyCloseCritical({ householdId }, '2026-03');
  assert.equal(result.counts.outstandingPartnerBuckets, 0);
  assert.equal(result.counts.unreviewedTransactions, 0);
  assert.equal(result.hasCritical, false);
});
