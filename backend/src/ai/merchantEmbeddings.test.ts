import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let sequelize: import('sequelize').Sequelize;
let mod: typeof import('./merchantEmbeddings');

before(async () => {
  models = await import('../models');
  sequelize = models.sequelize;
  mod = await import('./merchantEmbeddings');
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });
beforeEach(async () => {
  await models.MerchantEmbedding.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

test('cosineSimilarity: identical=1, orthogonal=0, mismatch/zero=0', () => {
  assert.equal(mod.cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(mod.cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(mod.cosineSimilarity([0, 0], [1, 0]), 0, 'zero vector → 0 not NaN');
  assert.equal(mod.cosineSimilarity([1, 0], [1, 0, 0]), 0, 'length mismatch → 0');
});

test('ensureEmbedding caches: a repeated merchant calls the embed fn once (AC #8)', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  let calls = 0;
  const embed = async (text: string) => { calls += 1; return [text.length, 0, 0]; };

  const v1 = await mod.ensureEmbedding({ householdId: hh.id, merchantClean: 'Costco', embed });
  const v2 = await mod.ensureEmbedding({ householdId: hh.id, merchantClean: 'Costco', embed });
  assert.deepEqual(v1, v2);
  assert.equal(calls, 1, 'second call served from cache');

  const rows = await models.MerchantEmbedding.count({ where: { householdId: hh.id, merchantClean: 'Costco' } });
  assert.equal(rows, 1, 'unique (household, merchant, model) → one cached row (AC #9)');
});

test('ensureEmbedding does not insert a duplicate for the same key (AC #9)', async () => {
  const hh = await models.Household.create({ name: 'H' } as never);
  const embed = async () => [1, 2, 3];
  await mod.ensureEmbedding({ householdId: hh.id, merchantClean: 'Apple', embed });
  await mod.ensureEmbedding({ householdId: hh.id, merchantClean: 'Apple', embed });
  const count = await models.MerchantEmbedding.count({ where: { householdId: hh.id, merchantClean: 'Apple' } });
  assert.equal(count, 1);
});

async function reviewedTxn(householdId: number, accountId: number, over: Record<string, unknown>) {
  const fp = `fp-${Math.random()}`;
  return models.Transaction.create({
    accountId,
    householdId,
    visibility: 'private',
    importBatch: 'test',
    date: '2026-06-01',
    amount: '-10.00',
    currency: 'CAD',
    merchantRaw: 'RAW',
    merchantClean: 'Blue Bottle Coffee',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: false,
    finalSplitType: 'me',
    reviewedAt: new Date('2026-06-02'),
    finalCategory: 'Coffee',
    ...over,
  } as never);
}

test('loadHouseholdMerchants returns only this household reviewed/categorized merchants (AC #10)', async () => {
  const a = await models.Household.create({ name: 'A' } as never);
  const b = await models.Household.create({ name: 'B' } as never);
  const accA = await models.Account.create({ householdId: a.id, name: 'CA', visibility: 'private' } as never);
  const accB = await models.Account.create({ householdId: b.id, name: 'CB', visibility: 'private' } as never);

  await reviewedTxn(a.id, accA.id, { merchantClean: 'Blue Bottle Coffee', finalCategory: 'Coffee' });
  await reviewedTxn(b.id, accB.id, { merchantClean: 'Whole Foods', finalCategory: 'Groceries' });
  // Unreviewed / uncategorized rows must not appear.
  await reviewedTxn(a.id, accA.id, { merchantClean: 'Mystery', reviewedAt: null, finalCategory: null });

  const forA = await mod.loadHouseholdMerchants(a.id);
  assert.deepEqual(forA.map((m) => m.merchantClean).sort(), ['Blue Bottle Coffee']);
  const forB = await mod.loadHouseholdMerchants(b.id);
  assert.deepEqual(forB.map((m) => m.merchantClean).sort(), ['Whole Foods']);
});
