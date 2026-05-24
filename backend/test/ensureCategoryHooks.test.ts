import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../src/db';
import {
  Account,
  BudgetTarget,
  Category,
  Household,
  Rule,
  Transaction,
} from '../src/models';

before(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Category.destroy({ where: {}, truncate: true });
  await Transaction.destroy({ where: {}, truncate: true });
  await Rule.destroy({ where: {}, truncate: true });
  await BudgetTarget.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
});

async function seedAccount(householdId: number) {
  return Account.create({
    name: 'Test',
    householdId,
    accountType: 'checking',
    defaultCurrency: 'CAD',
  } as never);
}

test('Transaction afterSave: ensures category for finalCategory', async () => {
  const hh = await Household.create({ name: 'H' });
  const acct = await seedAccount(hh.id);
  await Transaction.create({
    accountId: acct.id,
    householdId: hh.id,
    date: '2026-01-01',
    amount: '10.00',
    currency: 'CAD',
    merchantRaw: 'starbucks',
    merchantClean: 'Starbucks',
    importBatch: 'test-hook',
    sourceRowFingerprint: 'fp-hook-1',
    sourceIdentityFingerprint: 'sif-hook-1',
    finalCategory: 'Coffee',
  } as never);
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Coffee']
  );
});

test('Transaction afterSave: no-op when finalCategory is null', async () => {
  const hh = await Household.create({ name: 'H' });
  const acct = await seedAccount(hh.id);
  await Transaction.create({
    accountId: acct.id,
    householdId: hh.id,
    date: '2026-01-01',
    amount: '10.00',
    currency: 'CAD',
    merchantRaw: 'x',
    merchantClean: 'X',
    importBatch: 'test-hook',
    sourceRowFingerprint: 'fp-hook-null',
    sourceIdentityFingerprint: 'sif-hook-null',
    finalCategory: null,
  } as never);
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 0);
});

test('Rule afterSave: ensures category', async () => {
  const hh = await Household.create({ name: 'H' });
  await Rule.create({
    merchantPattern: 'foo',
    householdId: hh.id,
    matchKind: 'contains',
    priority: 0,
    splitType: 'me',
    isBusiness: false,
    category: 'Subscriptions',
  } as never);
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.deepEqual(rows.map((r) => r.name), ['Subscriptions']);
});

test('BudgetTarget afterSave: ensures category', async () => {
  const hh = await Household.create({ name: 'H' });
  await BudgetTarget.create({
    householdId: hh.id,
    category: 'Rent',
    currency: 'CAD',
    amount: '1200',
  } as never);
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.deepEqual(rows.map((r) => r.name), ['Rent']);
});

test('Transaction afterSave: no-op when householdId is null', async () => {
  const hh = await Household.create({ name: 'H' });
  const acct = await seedAccount(hh.id);
  await Transaction.create({
    accountId: acct.id,
    householdId: null,
    date: '2026-01-01',
    amount: '10.00',
    currency: 'CAD',
    merchantRaw: 'x',
    merchantClean: 'X',
    importBatch: 'test-hook',
    sourceRowFingerprint: 'fp-hh-null',
    sourceIdentityFingerprint: 'sif-hh-null',
    finalCategory: 'ShouldNotAppear',
  } as never);
  const rows = await Category.findAll();
  assert.equal(rows.length, 0);
});

test('Rule afterSave: no-op when householdId is null', async () => {
  await Rule.create({
    merchantPattern: 'foo',
    householdId: null,
    matchKind: 'contains',
    priority: 0,
    splitType: 'me',
    isBusiness: false,
    category: 'ShouldNotAppear',
  } as never);
  const rows = await Category.findAll();
  assert.equal(rows.length, 0);
});
