/**
 * Safe-to-spend is a PERSONAL liquidity metric: it must count only accounts
 * belonging to the household's `personal` tax entity and exclude `corp`-entity
 * accounts (business cash is not personally spendable). Regression lock for the
 * prod bug where ~$39k of corporate Wealthsimple/Wise cash inflated the
 * dashboard's safe-to-spend tile.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sequelize } from '../db';
import { Account, Entity, Household, User } from '../models';
import {
  computeSafeToSpend,
  getExpectedIncome,
  getIncomeLegs,
} from './safeToSpend';

let HH = 0;
let USER = 0;
let PERSONAL = 0;
let CORP = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  const user = await User.create({
    email: 'sts@example.com',
    displayName: 'STS',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  const household = await Household.create({ name: 'STS household' } as never);
  HH = household.id;
  USER = user.id;
  const personal = await Entity.create({
    householdId: HH,
    kind: 'personal',
    legalName: 'Personal',
    jurisdiction: 'CA-ON',
  } as never);
  const corp = await Entity.create({
    householdId: HH,
    kind: 'corp',
    legalName: 'CDG Labs Inc.',
    jurisdiction: 'CA-ON',
  } as never);
  PERSONAL = personal.id;
  CORP = corp.id;
});

function mkAccount(
  name: string,
  entityId: number,
  accountType = 'chequing',
): ReturnType<typeof Account.create> {
  return Account.create({
    name,
    householdId: HH,
    ownerUserId: USER,
    owner: 'me',
    visibility: 'household',
    accountType,
    defaultCurrency: 'CAD',
    openingBalance: '0.0000',
    entityId,
  } as never);
}

async function seedCash(accountId: number, amount: number): Promise<void> {
  await seedTxn(accountId, '2026-01-01', amount, 'Seed');
}

/** Seed one transaction; returns its id so callers can link against it. */
async function seedTxn(
  accountId: number,
  date: string,
  amount: number,
  merchant: string,
  txnType: string | null = null,
  extra: { linkedTransactionId?: number; currency?: string } = {},
): Promise<number> {
  const { Transaction } = await import('../models');
  const row = await Transaction.create({
    accountId,
    householdId: HH,
    visibility: 'household',
    ownershipType: 'me',
    importBatch: 'sts-entity-test',
    date,
    merchantRaw: merchant,
    merchantClean: merchant,
    amount: amount.toFixed(4),
    currency: extra.currency ?? 'CAD',
    ...(txnType != null ? { txnType } : {}),
    ...(extra.linkedTransactionId != null
      ? { linkedTransactionId: extra.linkedTransactionId }
      : {}),
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  } as never);
  return row.id;
}

/**
 * Seed a corp -> personal owner draw: the corp-side outflow plus the
 * personal-side inflow that links back to it. Returns the personal txn id.
 */
async function seedOwnerDraw(
  corpAccountId: number,
  personalAccountId: number,
  date: string,
  amount: number,
  currency = 'CAD',
): Promise<number> {
  const corpSide = await seedTxn(
    corpAccountId,
    date,
    -amount,
    'Transfer',
    'transfer',
    { currency },
  );
  return seedTxn(personalAccountId, date, amount, 'Transfer', 'transfer', {
    linkedTransactionId: corpSide,
    currency,
  });
}

/** A biweekly paycheck stream ending just before asOf 2026-06-20. */
const PAY_DATES = ['2026-04-24', '2026-05-08', '2026-05-22', '2026-06-05', '2026-06-19'];

test('corp-entity cash is excluded from currentCash; only personal counts', async () => {
  const personalAcct = await mkAccount('Personal Chequing', PERSONAL);
  const corpAcct = await mkAccount('Corp Chequing', CORP);
  await seedCash(personalAcct.id, 2000);
  await seedCash(corpAcct.id, 39000);

  const res = await computeSafeToSpend({
    userId: USER,
    householdId: HH,
    currency: 'CAD',
    asOfDate: '2026-06-01',
  });

  assert.equal(res.breakdown.currentCash, 2000);
  assert.equal(res.value, 2000);
});

test('corp-entity credit-card balance is excluded from expected payments', async () => {
  const personalAcct = await mkAccount('Personal Chequing', PERSONAL);
  await seedCash(personalAcct.id, 3000);
  const personalCc = await mkAccount('Personal CC', PERSONAL, 'credit_card');
  const corpCc = await mkAccount('Corp CC', CORP, 'credit_card');
  await seedCash(personalCc.id, -300); // owe 300 personally
  await seedCash(corpCc.id, -5000); // corp owes 5000 — must NOT count

  const res = await computeSafeToSpend({
    userId: USER,
    householdId: HH,
    currency: 'CAD',
    asOfDate: '2026-06-01',
  });

  assert.equal(res.breakdown.currentCash, 3000);
  assert.equal(res.breakdown.expectedCreditCardPayments, 300);
  assert.equal(res.value, 2700);
});

async function seedLiabilityProfile(
  accountId: number,
  statementBalance: number | null,
  dueDay: number | null,
): Promise<void> {
  const { LiabilityAccount } = await import('../models');
  await LiabilityAccount.create({
    accountId,
    householdId: HH,
    statementBalance: statementBalance == null ? null : statementBalance.toFixed(4),
    dueDay,
  } as never);
}

test('reserves the statement balance, not the full current balance, when due in window', async () => {
  const personalAcct = await mkAccount('Personal Chequing', PERSONAL);
  await seedCash(personalAcct.id, 3000);
  const cc = await mkAccount('Personal CC', PERSONAL, 'credit_card');
  await seedCash(cc.id, -10000); // full current balance owed is 10k…
  await seedLiabilityProfile(cc.id, 8000, 10); // …but only 8k is billed, due Jun 10 (in 14d window)

  const res = await computeSafeToSpend({
    userId: USER,
    householdId: HH,
    currency: 'CAD',
    asOfDate: '2026-06-01',
  });

  assert.equal(res.breakdown.expectedCreditCardPayments, 8000);
  assert.equal(res.value, 3000 - 8000);
});

test('reserves nothing for a credit card whose statement is due outside the window', async () => {
  const personalAcct = await mkAccount('Personal Chequing', PERSONAL);
  await seedCash(personalAcct.id, 3000);
  const cc = await mkAccount('Personal CC', PERSONAL, 'credit_card');
  await seedCash(cc.id, -10000);
  await seedLiabilityProfile(cc.id, 8000, 25); // due Jun 25 — past the Jun 15 window end

  const res = await computeSafeToSpend({
    userId: USER,
    householdId: HH,
    currency: 'CAD',
    asOfDate: '2026-06-01',
  });

  assert.equal(res.breakdown.expectedCreditCardPayments, 0);
  assert.equal(res.value, 3000);
});

test('recurring personal paycheck is detected and added back as expected income', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  await seedCash(chequing.id, 1000);
  for (const d of PAY_DATES) await seedTxn(chequing.id, d, 2500, 'ACME PAYROLL');

  const res = await computeSafeToSpend({
    userId: USER,
    householdId: HH,
    currency: 'CAD',
    asOfDate: '2026-06-20',
  });

  // Next biweekly occurrence after 2026-06-19 is 2026-07-03 — inside the 14d window.
  assert.equal(res.breakdown.expectedIncome, 2500);
  // currentCash = 1000 seed + 5 × 2500 paychecks already received = 13500.
  assert.equal(res.breakdown.currentCash, 13500);
  assert.equal(res.value, 13500 + 2500);
});

test('corp-entity paycheck is excluded from expected income', async () => {
  const personal = await mkAccount('Personal Chequing', PERSONAL);
  await seedCash(personal.id, 1000);
  const corp = await mkAccount('Corp Chequing', CORP);
  for (const d of PAY_DATES) await seedTxn(corp.id, d, 9000, 'CORP PAYROLL');

  const res = await computeSafeToSpend({
    userId: USER,
    householdId: HH,
    currency: 'CAD',
    asOfDate: '2026-06-20',
  });

  assert.equal(res.breakdown.expectedIncome, 0);
});

test('recurring transfers are not counted as income', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  await seedCash(chequing.id, 1000);
  for (const d of PAY_DATES) await seedTxn(chequing.id, d, 2500, 'INTERNAL XFER', 'transfer');

  const res = await computeSafeToSpend({
    userId: USER,
    householdId: HH,
    currency: 'CAD',
    asOfDate: '2026-06-20',
  });

  assert.equal(res.breakdown.expectedIncome, 0);
});

test('getExpectedIncome projects an in-window paycheck occurrence directly', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  for (const d of PAY_DATES) await seedTxn(chequing.id, d, 2500, 'ACME PAYROLL');

  const income = await getExpectedIncome(HH, 'CAD', '2026-06-20', '2026-07-04', new Set());
  assert.equal(income, 2500);
});

test('getExpectedIncome ignores income in a different currency', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  for (const d of PAY_DATES) await seedTxn(chequing.id, d, 2500, 'ACME PAYROLL');

  const income = await getExpectedIncome(HH, 'USD', '2026-06-20', '2026-07-04', new Set());
  assert.equal(income, 0);
});

/*
 * Owner-draw income (#990). An owner-operator's pay is a variable, irregular
 * corp -> personal distribution tagged `transfer`, which the paycheck detector
 * excludes outright — so expectedIncome read $0 forever. These lock the
 * corp-link signal that separates a real draw from an internal shuffle.
 */

const ASOF = '2026-09-13';
/** asOf + the 14-day default window. */
const WINDOW_END = '2026-09-27';

test('a personal inflow linked to a corp-entity txn counts as owner-draw income', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  const corpChequing = await mkAccount('Corp Chequing', CORP);
  await seedOwnerDraw(corpChequing.id, chequing.id, '2026-07-14', 6000);

  const legs = await getIncomeLegs(HH, 'CAD', ASOF, WINDOW_END, new Set([CORP]));
  // 6000 over a 90d lookback = 66.67/day; x 14d window = 933.33
  assert.equal(legs.ownerDrawIncome, 933.33);
  assert.equal(legs.recurringIncome, 0);
});

test('a transfer linked to another PERSONAL account is an internal shuffle, not income', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  const savings = await mkAccount('Personal Savings', PERSONAL, 'savings');
  const outflow = await seedTxn(savings.id, '2026-07-14', -6000, 'Transfer', 'transfer');
  await seedTxn(chequing.id, '2026-07-14', 6000, 'Transfer', 'transfer', {
    linkedTransactionId: outflow,
  });

  const legs = await getIncomeLegs(HH, 'CAD', ASOF, WINDOW_END, new Set([CORP]));
  assert.equal(legs.ownerDrawIncome, 0);
});

test('an UNLINKED transfer inflow is not counted (coverage gap, not income)', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  await seedTxn(chequing.id, '2026-07-14', 6000, 'Transfer', 'transfer');

  const legs = await getIncomeLegs(HH, 'CAD', ASOF, WINDOW_END, new Set([CORP]));
  assert.equal(legs.ownerDrawIncome, 0);
});

test('owner-draw income is currency-scoped', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  const corpChequing = await mkAccount('Corp Chequing', CORP);
  await seedOwnerDraw(corpChequing.id, chequing.id, '2026-07-14', 6000);

  const legs = await getIncomeLegs(HH, 'USD', ASOF, WINDOW_END, new Set([CORP]));
  assert.equal(legs.ownerDrawIncome, 0);
});

test('draws older than the 90-day lookback do not count', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  const corpChequing = await mkAccount('Corp Chequing', CORP);
  await seedOwnerDraw(corpChequing.id, chequing.id, '2026-03-27', 10000);

  const legs = await getIncomeLegs(HH, 'CAD', ASOF, WINDOW_END, new Set([CORP]));
  assert.equal(legs.ownerDrawIncome, 0);
});

test('a corp-linked inflow is counted ONCE — as a draw, never also as a paycheck', async () => {
  // Regular cadence + stable amount: this WOULD qualify as a recurring paycheck
  // if the corp link were ignored. It must land in exactly one leg.
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  const corpChequing = await mkAccount('Corp Chequing', CORP);
  for (const d of ['2026-08-16', '2026-08-30', '2026-09-13']) {
    await seedOwnerDraw(corpChequing.id, chequing.id, d, 2500);
  }

  const legs = await getIncomeLegs(HH, 'CAD', ASOF, WINDOW_END, new Set([CORP]));
  assert.equal(legs.recurringIncome, 0);
  // 7500 over 90d = 83.33/day; x 14d = 1166.67
  assert.equal(legs.ownerDrawIncome, 1166.67);
});

test('the two income legs compose: a salaried paycheck AND a corp draw both count', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  const corpChequing = await mkAccount('Corp Chequing', CORP);
  for (const d of ['2026-08-16', '2026-08-30', '2026-09-13']) {
    await seedTxn(chequing.id, d, 2000, 'ACME PAYROLL');
  }
  await seedOwnerDraw(corpChequing.id, chequing.id, '2026-07-14', 6000);

  const legs = await getIncomeLegs(HH, 'CAD', ASOF, WINDOW_END, new Set([CORP]));
  assert.equal(legs.recurringIncome, 2000); // one biweekly occurrence lands 2026-09-27
  assert.equal(legs.ownerDrawIncome, 933.33);
});

test('computeSafeToSpend surfaces both legs and expectedIncome is their sum', async () => {
  const chequing = await mkAccount('Personal Chequing', PERSONAL);
  const corpChequing = await mkAccount('Corp Chequing', CORP);
  await seedCash(chequing.id, 1000);
  await seedOwnerDraw(corpChequing.id, chequing.id, '2026-07-14', 6000);

  const res = await computeSafeToSpend({
    userId: USER,
    householdId: HH,
    currency: 'CAD',
    asOfDate: ASOF,
  });

  assert.equal(res.breakdown.ownerDrawIncome, 933.33);
  assert.equal(res.breakdown.recurringIncome, 0);
  assert.equal(res.breakdown.expectedIncome, 933.33);
  // The July draw already LANDED, so it sits in personal cash (1000 seed +
  // 6000). The income leg projects the FUTURE draw rate on top — the past
  // draw and the forward rate are different money, so this is not a
  // double-count. The corp-side outflow never enters cash at all.
  assert.equal(res.breakdown.currentCash, 7000);
  assert.equal(res.value, 7933.33);
});
