/**
 * How merchant memory resolves a bucket whose reviewed rows DISAGREE.
 *
 * Re-normalizing `merchant_clean` (PR: boilerplate stripping + migration
 * 20260928000002) merges memory buckets: rows that used to carry N distinct
 * boilerplate-laden keys now share one. Merging support counts means two
 * previously-separate decisions can end up under the same key with different
 * categories — in production this is real, not hypothetical: the Wealthsimple
 * transfer sentences are labelled `Transfer` some months and `Investments`
 * others.
 *
 * THE MERGE RULE. Nothing rewrites a row's label; the merged bucket keeps every
 * row's own decision, and the winner is chosen at read time by:
 *   1. highest support count,
 *   2. then most recent `reviewed_at`,
 *   3. then category name (ascending), then split type, then business flag.
 * Step 3 exists so a full tie is decided by the *data*, not by which row the
 * database happens to return first.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Transaction: typeof import('../models').Transaction;
let findMerchantMemory: typeof import('./merchantMemory').findMerchantMemory;

const KEY = 'Money transfer out of the account';

before(async () => {
  const models = await import('../models');
  sequelize = models.sequelize;
  Transaction = models.Transaction;
  ({ findMerchantMemory } = await import('./merchantMemory'));
  await sequelize.sync({ force: true });
  // Transaction's beforeSave hook resolves finalCategory -> a Category row,
  // which is household-scoped, so the FK targets have to exist.
  await models.Household.create({ id: 1, name: 'Test' } as Parameters<typeof models.Household.create>[0]);
  await models.Account.create({
    id: 1,
    householdId: 1,
    name: 'Chequing',
    accountType: 'chequing',
    currency: 'CAD',
  } as Parameters<typeof models.Account.create>[0]);
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
});

let seq = 0;
async function reviewed(category: string, reviewedAt: string, amount = '-100.0000') {
  seq += 1;
  return Transaction.create({
    accountId: 1,
    householdId: 1,
    date: '2026-03-08',
    merchantRaw: `${KEY} (executed at 2026-03-0${(seq % 9) + 1})`,
    merchantClean: KEY,
    amount,
    currency: 'CAD',
    importBatch: 'test-batch',
    sourceRowFingerprint: `row-${seq}`,
    sourceIdentityFingerprint: `fp-${seq}`,
    finalCategory: category,
    reviewedAt: new Date(reviewedAt),
  } as Parameters<typeof Transaction.create>[0]);
}

test('the higher-support decision wins a merged bucket', async () => {
  await reviewed('Transfer', '2026-03-09T00:00:00Z');
  await reviewed('Transfer', '2026-04-09T00:00:00Z');
  await reviewed('Investments', '2026-09-09T00:00:00Z');

  const match = await findMerchantMemory(1, KEY, null);
  assert.ok(match);
  assert.equal(match.category, 'Transfer', 'support 2 beats support 1 even though the loser is newer');
  assert.equal(match.supportCount, 2);
});

test('on equal support the most recently reviewed decision wins', async () => {
  await reviewed('Transfer', '2026-03-09T00:00:00Z');
  await reviewed('Investments', '2026-09-09T00:00:00Z');

  const match = await findMerchantMemory(1, KEY, null);
  assert.ok(match);
  assert.equal(match.category, 'Investments');
  assert.equal(match.supportCount, 1);
});

test('a full tie is broken by the data, not by insertion order', async () => {
  const at = '2026-05-01T00:00:00Z';
  await reviewed('Transfer', at);
  await reviewed('Investments', at);
  const forward = await findMerchantMemory(1, KEY, null);

  await Transaction.destroy({ where: {}, truncate: true });
  await reviewed('Investments', at);
  await reviewed('Transfer', at);
  const reverse = await findMerchantMemory(1, KEY, null);

  assert.ok(forward);
  assert.ok(reverse);
  assert.equal(
    forward.category,
    reverse.category,
    'same tie must resolve the same way whichever row was written first',
  );
  assert.equal(forward.category, 'Investments', 'ascending category name is the documented tie-break');
});

test('a merged bucket reports the combined support count', async () => {
  await reviewed('Transfer', '2026-03-09T00:00:00Z');
  await reviewed('Transfer', '2026-04-09T00:00:00Z');
  await reviewed('Transfer', '2026-05-09T00:00:00Z');
  await reviewed('Transfer', '2026-06-09T00:00:00Z');

  // Four merged priors is exactly the any-amount threshold at which
  // `runMerchantMemoryStage` promotes memory to `high` confidence — the payoff
  // of de-fragmenting the key.
  const match = await findMerchantMemory(1, KEY, null);
  assert.ok(match);
  assert.equal(match.supportCount, 4);
  assert.equal(match.matchedByAmount, false);
});
