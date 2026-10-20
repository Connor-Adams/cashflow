/**
 * restoreBundle must insert each bundle row exactly once.
 *
 * On SQLite the RETURNING insert used to land the row and then throw inside
 * Sequelize, so the fallback path inserted the same row a second time. The
 * other restore tests look rows up by merchant name and never noticed the
 * duplicates; this one asserts exact row counts per table.
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../models/Account').Account;
let Household: typeof import('../models/Household').Household;
let Rule: typeof import('../models/Rule').Rule;
let Transaction: typeof import('../models/Transaction').Transaction;
let buildBundle: typeof import('./buildBundle').buildBundle;
let restoreBundle: typeof import('./restoreBundle').restoreBundle;

before(async () => {
  const models = await import('../models');
  ({ sequelize, Account, Household, Rule, Transaction } = models);
  ({ buildBundle } = await import('./buildBundle'));
  ({ restoreBundle } = await import('./restoreBundle'));
  await sequelize.sync({ force: true });
});
after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Rule.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
});

async function seedTxn(accountId: number, householdId: number, n: number): Promise<void> {
  await Transaction.create({
    accountId,
    householdId,
    importBatch: 'b',
    date: '2026-01-01',
    merchantRaw: `M${n}`,
    merchantClean: `M${n}`,
    amount: `${n}.0000`,
    currency: 'CAD',
    sourceRowFingerprint: `fp-${n}-${Math.random()}`,
    sourceIdentityFingerprint: `id-${n}-${Math.random()}`,
    reviewFlag: false,
  });
}

test('restore inserts every bundle row exactly once', async () => {
  const source = await Household.create({ name: 'Source' });
  const chequing = await Account.create({ name: 'Chequing', owner: 'me', householdId: source.id });
  const savings = await Account.create({ name: 'Savings', owner: 'me', householdId: source.id });
  await Rule.create({ merchantPattern: 'COFFEE', householdId: source.id, matchKind: 'contains', priority: 1 });
  await seedTxn(chequing.id, source.id, 1);
  await seedTxn(chequing.id, source.id, 2);
  await seedTxn(savings.id, source.id, 3);

  const payload = await buildBundle(sequelize, { householdId: source.id, origin: 'test' });
  const target = await Household.create({ name: 'Target' });
  const result = await restoreBundle(sequelize, payload, { householdId: target.id, userId: 1 });

  const counts = {
    accounts: await Account.count({ where: { householdId: target.id } }),
    rules: await Rule.count({ where: { householdId: target.id } }),
    transactions: await Transaction.count({ where: { householdId: target.id } }),
  };
  assert.deepEqual(counts, { accounts: 2, rules: 1, transactions: 3 });
  assert.equal(result.inserted.accounts, 2);
  assert.equal(result.inserted.rules, 1);
  assert.equal(result.inserted.transactions, 3);

  // Every restored transaction points at a restored account (ids remapped to
  // the rows that were kept, not to a duplicate).
  const targetAccountIds = new Set(
    (await Account.findAll({ where: { householdId: target.id } })).map((a) => a.id),
  );
  const txns = await Transaction.findAll({ where: { householdId: target.id } });
  for (const t of txns) assert.ok(targetAccountIds.has(t.accountId));

  // The source household is untouched.
  assert.equal(await Transaction.count({ where: { householdId: source.id } }), 3);
});
