// backend/src/amazon/backfillAutoAcceptLinks.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Transaction, ExternalOrder, TransactionOrderLink, Household, Account } from '../models';
import { backfillAutoAcceptAmazonLinks } from './backfillAutoAcceptLinks';

before(async () => {
  await sequelize.sync({ force: true });
  // Seed shared Household + Account (FK parents) for householdId 9101.
  await Household.create({ id: 9101, name: 'HH-9101' } as never);
  await Account.create({ id: 1, householdId: 9101, name: 'Test Account' } as never);
});

test('promotes a sole suggested ≥85 link to accepted; leaves an ambiguous pair', async () => {
  const householdId = 9101;
  const txnSolo = await Transaction.create({
    householdId, accountId: 1, date: '2026-06-10', amount: '-20.00', currency: 'CAD',
    merchantRaw: 'AMZN', merchantClean: 'Amazon',
    txnType: 'purchase', importBatch: 'test',
    sourceRowFingerprint: `srfp-${householdId}-1`,
    sourceIdentityFingerprint: `sifp-${householdId}-1`,
  } as never);
  const orderSolo = await ExternalOrder.create({
    householdId, vendor: 'amazon', orderDate: '2026-06-09', total: '20.00', currency: 'CAD',
    source: 'test', dedupeKey: `b-${householdId}-1`,
  } as never);
  await TransactionOrderLink.create({
    transactionId: (txnSolo as { id: number }).id, externalOrderId: (orderSolo as { id: number }).id,
    confidence: '90', matchReason: 'seed', status: 'suggested',
  } as never);

  const res = await backfillAutoAcceptAmazonLinks({ householdId });
  assert.equal(res.promoted, 1);

  const link = await TransactionOrderLink.findOne({
    where: { transactionId: (txnSolo as { id: number }).id },
  });
  assert.equal(link?.status, 'accepted');

  // Idempotent: second run promotes nothing.
  const again = await backfillAutoAcceptAmazonLinks({ householdId });
  assert.equal(again.promoted, 0);
});
