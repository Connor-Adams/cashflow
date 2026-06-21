import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Transaction, Account } from '../models';
import { hasMatchingTransaction } from './matchReceiptToTransactions';

let accountId: number;

before(async () => {
  await sequelize.sync({ force: true });
});
beforeEach(async () => {
  await Transaction.destroy({ where: {} });
  await Account.destroy({ where: {} });
  const account = await Account.create({
    householdId: 1,
    name: 'Test Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  } as never);
  accountId = account.id;
});

test('returns true when a same-amount, in-window transaction exists', async () => {
  await Transaction.create({
    householdId: 1,
    accountId,
    date: '2026-06-10',
    amount: '42.00',
    currency: 'CAD',
    merchantRaw: 'FOOSHOP',
    merchantClean: 'Fooshop',
    importBatch: 'test-batch',
    sourceRowFingerprint: 'fp1',
    sourceIdentityFingerprint: 'ifp1',
  } as never);
  const matched = await hasMatchingTransaction({
    householdId: 1,
    vendor: 'other',
    total: 42.0,
    currency: 'CAD',
    orderDate: '2026-06-10',
    paymentLast4: null,
  });
  assert.equal(matched, true);
});

test('returns false when no transaction is close in amount or date', async () => {
  await Transaction.create({
    householdId: 1,
    accountId,
    date: '2026-01-01',
    amount: '999.00',
    currency: 'CAD',
    merchantRaw: 'OTHER',
    merchantClean: 'Other',
    importBatch: 'test-batch',
    sourceRowFingerprint: 'fp2',
    sourceIdentityFingerprint: 'ifp2',
  } as never);
  const matched = await hasMatchingTransaction({
    householdId: 1,
    vendor: 'other',
    total: 42.0,
    currency: 'CAD',
    orderDate: '2026-06-10',
    paymentLast4: null,
  });
  assert.equal(matched, false);
});

test('returns false when total is null', async () => {
  const matched = await hasMatchingTransaction({
    householdId: 1,
    vendor: 'other',
    total: null,
    currency: 'CAD',
    orderDate: '2026-06-10',
    paymentLast4: null,
  });
  assert.equal(matched, false);
});
