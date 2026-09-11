// backend/src/amazon/backfillAutoAcceptLinks.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Transaction, ExternalOrder, TransactionOrderLink, Household, Account } from '../models';
import { backfillAutoAcceptAmazonLinks } from './backfillAutoAcceptLinks';
import { runAmazonMatching } from './matcher';

before(async () => {
  await sequelize.sync({ force: true });
  // Seed shared Household + Account (FK parents) for householdId 9101.
  await Household.create({ id: 9101, name: 'HH-9101' } as never);
  await Account.create({ id: 1, householdId: 9101, name: 'Test Account' } as never);
  // Seed Household + Account for householdId 9102 (ambiguous-pair test).
  await Household.create({ id: 9102, name: 'HH-9102' } as never);
  await Account.create({ id: 2, householdId: 9102, name: 'Test Account 2' } as never);
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

test('leaves both links suggested when a transaction has two competing suggested links (ambiguous pair)', async () => {
  const householdId = 9102;
  const txnAmbig = await Transaction.create({
    householdId, accountId: 2, date: '2026-06-10', amount: '-35.00', currency: 'CAD',
    merchantRaw: 'AMZN', merchantClean: 'Amazon',
    txnType: 'purchase', importBatch: 'test',
    sourceRowFingerprint: `srfp-${householdId}-1`,
    sourceIdentityFingerprint: `sifp-${householdId}-1`,
  } as never);
  const orderA = await ExternalOrder.create({
    householdId, vendor: 'amazon', orderDate: '2026-06-09', total: '35.00', currency: 'CAD',
    source: 'test', dedupeKey: `b-${householdId}-1`,
  } as never);
  const orderB = await ExternalOrder.create({
    householdId, vendor: 'amazon', orderDate: '2026-06-08', total: '35.00', currency: 'CAD',
    source: 'test', dedupeKey: `b-${householdId}-2`,
  } as never);
  await TransactionOrderLink.create({
    transactionId: (txnAmbig as { id: number }).id, externalOrderId: (orderA as { id: number }).id,
    confidence: '90', matchReason: 'seed', status: 'suggested',
  } as never);
  await TransactionOrderLink.create({
    transactionId: (txnAmbig as { id: number }).id, externalOrderId: (orderB as { id: number }).id,
    confidence: '88', matchReason: 'seed', status: 'suggested',
  } as never);

  const res = await backfillAutoAcceptAmazonLinks({ householdId });
  assert.equal(res.promoted, 0, 'ambiguous pair must not be auto-promoted');

  const links = await TransactionOrderLink.findAll({
    where: { transactionId: (txnAmbig as { id: number }).id },
  });
  assert.equal(links.length, 2);
  for (const l of links) {
    assert.equal(l.status, 'suggested', `link ${l.externalOrderId} must remain suggested`);
  }
});

test('runAmazonMatching promotes a pre-existing high-confidence suggested link via the backfill', async () => {
  const householdId = 9103;
  await Household.create({ id: householdId, name: `HH-${householdId}` } as never);
  await Account.create({ id: 3, householdId, name: 'Test Account 3' } as never);

  const txn = await Transaction.create({
    householdId, accountId: 3, date: '2026-06-10', amount: '-44.97', currency: 'CAD',
    merchantRaw: 'AMZN MKTP CA*Z90R91K22', merchantClean: 'Amazon',
    txnType: 'purchase', importBatch: 'test',
    sourceRowFingerprint: `srfp-${householdId}-1`,
    sourceIdentityFingerprint: `sifp-${householdId}-1`,
  } as never);
  // Amount and date are both far off from the transaction on purpose: today's
  // live scoring floors this pair to confidence 0, so selectMatchCandidates
  // excludes it entirely and runAmazonMatching's live loop never calls
  // upsertSuggestedOrderLink for this (txn, order) pair — the pre-existing row
  // below is left completely untouched by the scan. Only the backfill, which
  // reasons from the link's OWN stored confidence rather than a fresh score,
  // can promote it. (An order whose current score still qualifies would be
  // re-promoted by the live loop itself, which wouldn't exercise the new call.)
  const order = await ExternalOrder.create({
    householdId, vendor: 'amazon', vendorOrderId: '701-1111111-2222222',
    dedupeKey: `b-${householdId}-1`, orderDate: '2020-01-01', total: '999.99', currency: 'CAD',
    source: 'amazon_report',
  } as never);
  // A link created before auto-accept existed: high confidence, still suggested.
  await TransactionOrderLink.create({
    transactionId: (txn as { id: number }).id, externalOrderId: (order as { id: number }).id,
    confidence: '88.00', matchReason: 'legacy', status: 'suggested',
  } as never);

  const result = await runAmazonMatching({ householdId });

  const link = await TransactionOrderLink.findOne({
    where: { transactionId: (txn as { id: number }).id, externalOrderId: (order as { id: number }).id },
  });
  assert.equal(link?.status, 'accepted');
  assert.equal(result.autoAccepted >= 1, true);
});
