/**
 * restoreBundle must preserve transaction-to-transaction links.
 *
 * `transactions.linked_transaction_id` pairs the two legs of a transfer and a
 * charge with its refund. Restore gives every row a fresh autoincrement id, so
 * the bundle's link values point at SOURCE ids. Restore must rewrite each link
 * to the NEW id of its target, and only null a link whose target was not in the
 * bundle (e.g. it points at another household's row). Before this was fixed,
 * every link was nulled, so restoring a backup unpaired every transfer/refund.
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../models/Account').Account;
let Household: typeof import('../models/Household').Household;
let Transaction: typeof import('../models/Transaction').Transaction;
let buildBundle: typeof import('./buildBundle').buildBundle;
let restoreBundle: typeof import('./restoreBundle').restoreBundle;

before(async () => {
  const models = await import('../models');
  ({ sequelize, Account, Household, Transaction } = models);
  ({ buildBundle } = await import('./buildBundle'));
  ({ restoreBundle } = await import('./restoreBundle'));
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

async function seedTxn(
  accountId: number,
  householdId: number,
  merchant: string,
  amount: string,
): Promise<InstanceType<typeof Transaction>> {
  return Transaction.create({
    accountId,
    householdId,
    importBatch: 'b',
    date: '2026-01-01',
    merchantRaw: merchant,
    merchantClean: merchant,
    amount,
    currency: 'CAD',
    sourceRowFingerprint: `fp-${merchant}-${Math.random()}`,
    sourceIdentityFingerprint: `id-${merchant}-${Math.random()}`,
    reviewFlag: false,
  });
}

const LINKED_AT = new Date('2026-02-03T04:05:06.000Z');

/** Seed a source household with a linked transfer pair (both directions set,
 *  transfer_linked_at stamped), plus one row linked to a transaction OUTSIDE the
 *  household (so it is not in the bundle). Returns the source ids. */
async function seedSource(): Promise<{
  sourceHouseholdId: number;
  outIds: { a: number; b: number; orphan: number };
}> {
  const source = await Household.create({ name: 'Source' });
  const chequing = await Account.create({ name: 'Chequing', owner: 'me', householdId: source.id });
  const savings = await Account.create({ name: 'Savings', owner: 'me', householdId: source.id });

  const a = await seedTxn(chequing.id, source.id, 'XFER OUT', '-100.0000');
  const b = await seedTxn(savings.id, source.id, 'XFER IN', '100.0000');
  await a.update({ txnType: 'transfer', linkedTransactionId: b.id, transferLinkedAt: LINKED_AT });
  await b.update({ txnType: 'transfer', linkedTransactionId: a.id, transferLinkedAt: LINKED_AT });

  // A row whose link target lives in another household — never in this bundle.
  const elsewhere = await Household.create({ name: 'Elsewhere' });
  const elsewhereAcct = await Account.create({ name: 'Else', owner: 'me', householdId: elsewhere.id });
  const foreign = await seedTxn(elsewhereAcct.id, elsewhere.id, 'FOREIGN', '5.0000');
  const orphan = await seedTxn(chequing.id, source.id, 'ORPHAN LINK', '-5.0000');
  await orphan.update({ linkedTransactionId: foreign.id });

  return { sourceHouseholdId: source.id, outIds: { a: a.id, b: b.id, orphan: orphan.id } };
}

async function assertLinksRestored(
  targetHouseholdId: number,
  sourceIds: { a: number; b: number; orphan: number },
): Promise<void> {
  const rows = await Transaction.findAll({ where: { householdId: targetHouseholdId } });
  const byMerchant = new Map(rows.map((r) => [r.merchantRaw, r]));
  const a = byMerchant.get('XFER OUT');
  const b = byMerchant.get('XFER IN');
  const orphan = byMerchant.get('ORPHAN LINK');
  assert.ok(a && b && orphan, 'all three transactions restored');

  // The restore really assigned fresh ids — otherwise "points at the new id"
  // would be indistinguishable from "kept the source id".
  assert.notEqual(a!.id, sourceIds.a, 'leg A got a fresh id');
  assert.notEqual(b!.id, sourceIds.b, 'leg B got a fresh id');

  assert.equal(a!.linkedTransactionId, b!.id, 'A links to the NEW id of B');
  assert.equal(b!.linkedTransactionId, a!.id, 'B links to the NEW id of A');
  assert.equal(
    new Date(a!.transferLinkedAt as unknown as string).toISOString(),
    LINKED_AT.toISOString(),
    'transfer_linked_at survives on A',
  );
  assert.equal(
    new Date(b!.transferLinkedAt as unknown as string).toISOString(),
    LINKED_AT.toISOString(),
    'transfer_linked_at survives on B',
  );
  assert.equal(
    orphan!.linkedTransactionId,
    null,
    'a link whose target was not in the bundle is nulled, never left dangling',
  );
}

test('merge restore rewrites linked_transaction_id to the new ids of both legs', async () => {
  const { sourceHouseholdId, outIds } = await seedSource();
  const payload = await buildBundle(sequelize, { householdId: sourceHouseholdId, origin: 'test' });

  const target = await Household.create({ name: 'Target' });
  await restoreBundle(sequelize, payload, { householdId: target.id, mode: 'merge' });

  await assertLinksRestored(target.id, outIds);
});

test('replace restore rewrites linked_transaction_id to the new ids of both legs', async () => {
  const { sourceHouseholdId, outIds } = await seedSource();
  const payload = await buildBundle(sequelize, { householdId: sourceHouseholdId, origin: 'test' });

  // Target already holds live data that replace mode must wipe first.
  const target = await Household.create({ name: 'Target' });
  const live = await Account.create({ name: 'Live', owner: 'me', householdId: target.id });
  await seedTxn(live.id, target.id, 'STALE', '-1.0000');

  await restoreBundle(sequelize, payload, { householdId: target.id, mode: 'replace' });

  const merchants = (await Transaction.findAll({ where: { householdId: target.id } })).map(
    (r) => r.merchantRaw,
  );
  assert.ok(!merchants.includes('STALE'), 'replace wiped the stale live row');
  await assertLinksRestored(target.id, outIds);
});

test('replace restore over the SAME household re-links the pair to the new ids', async () => {
  const { sourceHouseholdId, outIds } = await seedSource();
  const payload = await buildBundle(sequelize, { householdId: sourceHouseholdId, origin: 'test' });

  await restoreBundle(sequelize, payload, { householdId: sourceHouseholdId, mode: 'replace' });

  await assertLinksRestored(sourceHouseholdId, outIds);
});
