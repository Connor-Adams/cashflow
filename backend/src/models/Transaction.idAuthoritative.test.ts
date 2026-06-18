// backend/src/models/Transaction.idAuthoritative.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Transaction, Household, Category, Account } from '../models';

let householdId: number, accountId: number, work: number, child: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  accountId = (await Account.create({ householdId, name: 'A' })).id;
  work = (await Category.create({ householdId, name: 'Work', icon: null, parentId: null })).id;
  child = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: work })).id;
});

test('explicit child finalCategoryId sticks and is NOT clobbered to a root', async () => {
  const t = await Transaction.create({
    householdId,
    accountId,
    date: '2026-01-01',
    amount: -10,
    currency: 'CAD',
    importBatch: 'test-batch',
    merchantRaw: 'x',
    merchantClean: 'x',
    sourceRowFingerprint: 'fp-ia-1',
    sourceIdentityFingerprint: 'ifp-ia-1',
    reviewFlag: false,
    finalCategoryId: child,
  } as never);
  assert.equal(t.finalCategoryId, child);     // not re-resolved to a root
  assert.equal(t.finalCategory, 'Internet');  // string derived from the node
  // re-save (simulating a later edit) must not clobber the child id
  t.set('notes', 'edited');
  await t.save();
  await t.reload();
  assert.equal(t.finalCategoryId, child);
});

test('string-only finalCategory still resolves to a ROOT id', async () => {
  const t = await Transaction.create({
    householdId,
    accountId,
    date: '2026-01-01',
    amount: -5,
    currency: 'CAD',
    importBatch: 'test-batch',
    merchantRaw: 'y',
    merchantClean: 'y',
    sourceRowFingerprint: 'fp-ia-2',
    sourceIdentityFingerprint: 'ifp-ia-2',
    reviewFlag: false,
    finalCategory: 'Groceries',
  } as never);
  const node = await Category.findByPk(t.finalCategoryId!);
  assert.equal(node?.name, 'Groceries');
  assert.equal(node?.parentId, null);
});
