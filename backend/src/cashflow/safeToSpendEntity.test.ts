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
import { computeSafeToSpend } from './safeToSpend';

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

async function seedTxn(
  accountId: number,
  date: string,
  amount: number,
  merchant: string,
  txnType: string | null = null,
): Promise<void> {
  const { Transaction } = await import('../models');
  await Transaction.create({
    accountId,
    householdId: HH,
    visibility: 'household',
    ownershipType: 'me',
    importBatch: 'sts-entity-test',
    date,
    merchantRaw: merchant,
    merchantClean: merchant,
    amount: amount.toFixed(4),
    currency: 'CAD',
    ...(txnType != null ? { txnType } : {}),
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  } as never);
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
