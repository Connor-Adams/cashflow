/**
 * Integration test for the counterparty wiring (#372).
 *
 * Verifies that:
 *  - A checking-account transaction whose merchantRaw matches a known
 *    transfer pattern persists `counterpartyRaw` as the extracted name.
 *  - An investment-account transaction with the same merchantRaw persists
 *    `counterpartyRaw` as NULL (out-of-scope account types are ignored).
 *  - `counterpartyContactId` starts NULL and is independently writable.
 *
 * Mirrors the model-sync pattern used by ensureCategoryHooks.test.ts so the
 * test runs against an in-memory SQLite DB without requiring Postgres.
 *
 * This is the AC #7 stand-in: the full statement-parser → preview →
 * commitStatementImport pipeline is verified at the extractor unit-test
 * level; this test pins the persistence layer end-to-end.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCounterparty } from '../src/import/extractCounterparty';
import type { AccountType } from '@cashflow/shared';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models/Account').Account;
let Household: typeof import('../src/models/Household').Household;
let Transaction: typeof import('../src/models/Transaction').Transaction;

before(async () => {
  const models = await import('../src/models');
  sequelize = models.sequelize;
  Account = models.Account;
  Household = models.Household;
  Transaction = models.Transaction;
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
});

async function seed(accountType: AccountType) {
  const hh = await Household.create({ name: 'H' });
  const acct = await Account.create({
    name: `Test ${accountType}`,
    householdId: hh.id,
    accountType,
    defaultCurrency: 'CAD',
  } as never);
  return { hh, acct };
}

async function insert(merchantRaw: string, accountType: AccountType, fp: string) {
  const { hh, acct } = await seed(accountType);
  const counterpartyRaw = extractCounterparty(merchantRaw, accountType);
  const txn = await Transaction.create({
    accountId: acct.id,
    householdId: hh.id,
    date: '2026-01-01',
    amount: '100.00',
    currency: 'CAD',
    merchantRaw,
    merchantClean: merchantRaw,
    importBatch: `test-${fp}`,
    sourceRowFingerprint: `srf-${fp}`,
    sourceIdentityFingerprint: `sif-${fp}`,
    counterpartyRaw,
    counterpartyContactId: null,
  } as never);
  return Transaction.findByPk(txn.id);
}

test('checking account: Interac e-transfer persists counterpartyRaw', async () => {
  const reloaded = await insert(
    'INTERAC E-TFR FROM JANE DOE',
    'checking',
    'rbc-interac',
  );
  assert.equal(reloaded?.counterpartyRaw, 'JANE DOE');
  assert.equal(reloaded?.counterpartyContactId, null);
});

test('savings account: e-transfer persists counterpartyRaw', async () => {
  const reloaded = await insert(
    'E-TRANSFER FROM SARAH KIM',
    'savings',
    'savings-etf',
  );
  assert.equal(reloaded?.counterpartyRaw, 'SARAH KIM');
});

test('cash account: persists counterpartyRaw (manual entry style)', async () => {
  const reloaded = await insert(
    'INTERAC E-TFR FROM MIKE',
    'cash',
    'cash-mike',
  );
  assert.equal(reloaded?.counterpartyRaw, 'MIKE');
});

test('investment account: same merchantRaw yields counterpartyRaw NULL', async () => {
  const reloaded = await insert(
    'INTERAC E-TFR FROM JANE DOE',
    'investment',
    'ws-investment',
  );
  assert.equal(reloaded?.counterpartyRaw, null);
  assert.equal(reloaded?.counterpartyContactId, null);
});

test('credit_card account: ignored even when statement line matches', async () => {
  const reloaded = await insert(
    'ZELLE FROM SARAH KIM',
    'credit_card',
    'cc-zelle',
  );
  assert.equal(reloaded?.counterpartyRaw, null);
});

test('loan account: ignored even when statement line matches', async () => {
  const reloaded = await insert(
    'PAYROLL DEPOSIT ACME CORP',
    'loan',
    'loan-payroll',
  );
  assert.equal(reloaded?.counterpartyRaw, null);
});

test('counterpartyContactId is independently updatable', async () => {
  const { hh, acct } = await seed('checking');
  const txn = await Transaction.create({
    accountId: acct.id,
    householdId: hh.id,
    date: '2026-01-01',
    amount: '100.00',
    currency: 'CAD',
    merchantRaw: 'INTERAC E-TFR FROM JANE DOE',
    merchantClean: 'INTERAC E-TFR FROM JANE DOE',
    importBatch: 'test-promote',
    sourceRowFingerprint: 'srf-promote',
    sourceIdentityFingerprint: 'sif-promote',
    counterpartyRaw: 'JANE DOE',
    counterpartyContactId: null,
  } as never);
  txn.counterpartyContactId = 42;
  await txn.save();
  const reloaded = await Transaction.findByPk(txn.id);
  assert.equal(reloaded?.counterpartyContactId, 42);
  assert.equal(reloaded?.counterpartyRaw, 'JANE DOE');
});
