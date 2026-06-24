// backend/src/amazon/matcher.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Transaction, ExternalOrder, TransactionOrderLink, Household, Account } from '../models';
import { runAmazonMatching } from './matcher';

before(async () => {
  await sequelize.sync({ force: true });
});

// test/setup.ts gives each process a fresh SQLite DB with synced models.
async function seedHousehold(householdId: number) {
  const household = await Household.create({ id: householdId, name: `HH-${householdId}` } as never);
  const account = await Account.create({
    householdId: household.id, name: 'Test Account',
  } as never);

  // An Amazon txn that should score ≥85 against exactly one order:
  // amount within $0.50 (+50) + date 1 day after order (+25) + merchant Amazon (+15) = 90.
  const txn = await Transaction.create({
    householdId: household.id, accountId: account.id, date: '2026-06-10',
    amount: '-50.36', currency: 'CAD',
    merchantRaw: 'AMZN MKTP CA*ABC', merchantClean: 'Amazon', txnType: 'purchase',
    importBatch: 'test', sourceRowFingerprint: `srfp-${householdId}`, sourceIdentityFingerprint: `sifp-${householdId}`,
  } as never);
  const order = await ExternalOrder.create({
    householdId: household.id, vendor: 'amazon', orderDate: '2026-06-09', total: '50.36', currency: 'CAD',
    source: 'test', dedupeKey: `t-${householdId}-1`,
  } as never);
  return { txn, order };
}

test('runAmazonMatching auto-accepts a sole ≥85 candidate', async () => {
  const householdId = 9001;
  const { txn, order } = await seedHousehold(householdId);
  const res = await runAmazonMatching({ householdId });
  assert.ok(res.autoAccepted >= 1, 'expected at least one auto-accept');
  const link = await TransactionOrderLink.findOne({
    where: { transactionId: (txn as { id: number }).id, externalOrderId: (order as { id: number }).id },
  });
  assert.equal(link?.status, 'accepted');
});

test('runAmazonMatching does not re-count already-accepted link on second run', async () => {
  const householdId = 9002;
  await seedHousehold(householdId);
  // First run: should auto-accept and count it.
  const first = await runAmazonMatching({ householdId });
  assert.ok(first.autoAccepted >= 1, 'first run should auto-accept');
  // Second run: link is already accepted — must NOT increment autoAccepted again.
  const second = await runAmazonMatching({ householdId });
  assert.equal(second.autoAccepted, 0, 'second run must not re-count an already-accepted link');
});
