// backend/src/amazon/matcher.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Transaction, ExternalOrder, TransactionOrderLink, Household, Account } from '../models';
import { runAmazonMatching, scoreAmazonOrderMatch, selectMatchCandidates } from './matcher';

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

// ─── scoreAmazonOrderMatch secondaryScore integration tests ──────────────────

test('scoreAmazonOrderMatch returns secondaryScore=25 when date is within 5 days', async () => {
  // Verify the secondary score is populated with date proximity points only.
  // We build minimal Transaction/ExternalOrder-shaped objects (cast as needed).
  const txn = {
    amount: '-50.00',
    date: '2026-06-10',
    merchantRaw: 'SOME MERCHANT',
    merchantClean: 'Some Merchant',
    notes: null,
    sourceReference: null,
  } as unknown as Transaction;

  const orderWithDate = {
    total: '55.00', // diff $5 — no amount points (over $2 → penalty)
    orderDate: '2026-06-09', // 1 day before txn → date match
    shipmentDate: null,
    paymentLast4: null,
  } as unknown as ExternalOrder;

  const result = scoreAmazonOrderMatch(txn, orderWithDate);
  assert.equal(result.secondaryScore, 25, 'date within 5 days should contribute 25 secondary points');
});

test('scoreAmazonOrderMatch returns secondaryScore=20 when last4 matches', async () => {
  const txn = {
    amount: '-50.00',
    date: '2026-06-10',
    merchantRaw: 'SOME MERCHANT',
    merchantClean: 'Some Merchant',
    notes: 'card ending 1234',
    sourceReference: null,
  } as unknown as Transaction;

  const orderWithLast4 = {
    total: '55.00',
    orderDate: '2025-01-01', // far away — no date points
    shipmentDate: null,
    paymentLast4: '1234',
  } as unknown as ExternalOrder;

  const result = scoreAmazonOrderMatch(txn, orderWithLast4);
  assert.equal(result.secondaryScore, 20, 'last4 match should contribute 20 secondary points');
});

test('scoreAmazonOrderMatch returns secondaryScore=45 for date+last4 combined', async () => {
  const txn = {
    amount: '-50.00',
    date: '2026-06-10',
    merchantRaw: 'SOME MERCHANT',
    merchantClean: 'Some Merchant',
    notes: 'card ending 1234',
    sourceReference: null,
  } as unknown as Transaction;

  const orderBoth = {
    total: '55.00',
    orderDate: '2026-06-09', // 1 day before txn → date match
    shipmentDate: null,
    paymentLast4: '1234',
  } as unknown as ExternalOrder;

  const result = scoreAmazonOrderMatch(txn, orderBoth);
  assert.equal(result.secondaryScore, 45, 'date(25) + last4(20) should give secondaryScore=45');
});

test('scoreAmazonOrderMatch returns secondaryScore=0 for amount-only match (no date, no last4)', async () => {
  const txn = {
    amount: '-50.00',
    date: '2026-06-10',
    merchantRaw: 'SOME MERCHANT',
    merchantClean: 'Some Merchant',
    notes: null,
    sourceReference: null,
  } as unknown as Transaction;

  const orderAmountOnly = {
    total: '50.00', // exact match → +50 confidence, no secondary
    orderDate: '2026-05-01', // far away — date gap > 10 days, no secondary
    shipmentDate: null,
    paymentLast4: null,
  } as unknown as ExternalOrder;

  const result = scoreAmazonOrderMatch(txn, orderAmountOnly);
  assert.equal(result.secondaryScore, 0, 'amount-only match should have zero secondary score');
});

test('selectMatchCandidates with scoreAmazonOrderMatch-derived secondaryScore: tie-break by date/last4', async () => {
  // Two orders both score below threshold purely on amount ($1.50 diff → +35).
  // Order A also matches the date (+25 both confidence and secondary) → conf=60.
  // Order B has no date → conf=35 (below floor, filtered first).
  // Since they do NOT tie (60 vs 35), this verifies the secondary path works
  // when threaded from scoreAmazonOrderMatch results.
  // Separately, we verify tie-breaking by constructing tied objects from real scores.
  const txn = {
    amount: '-50.00',
    date: '2026-06-10',
    merchantRaw: 'SOME MERCHANT',
    merchantClean: 'Some Merchant',
    notes: null,
    sourceReference: null,
  } as unknown as Transaction;

  const orderDateMatch = {
    total: '51.50', // within $2 → +35
    orderDate: '2026-06-09', // 1 day before → +25 confidence, +25 secondary
    shipmentDate: null,
    paymentLast4: null,
  } as unknown as ExternalOrder;

  const orderNoDate = {
    total: '51.50', // within $2 → +35, no date
    orderDate: '2026-05-01', // gap > 10 days → -15
    shipmentDate: null,
    paymentLast4: null,
  } as unknown as ExternalOrder;

  const scoreA = scoreAmazonOrderMatch(txn, orderDateMatch);
  const scoreB = scoreAmazonOrderMatch(txn, orderNoDate);

  // Thread secondaryScore → secondary as runAmazonMatching does
  const candidates = [
    { id: 1, confidence: scoreA.confidence, secondary: scoreA.secondaryScore },
    { id: 2, confidence: scoreB.confidence, secondary: scoreB.secondaryScore },
  ];

  // scoreA.confidence = 60, scoreB.confidence = 20 → A wins outright (no tie)
  // This test validates the secondary field is correctly populated and threaded.
  assert.ok(scoreA.secondaryScore > 0, 'orderDateMatch should have positive secondaryScore');
  assert.equal(scoreB.secondaryScore, 0, 'orderNoDate should have zero secondaryScore');

  // Now manually create a tie at the same confidence to verify tiebreak logic
  const tiedCandidates = [
    { id: 1, confidence: 50, secondary: scoreA.secondaryScore }, // 25
    { id: 2, confidence: 50, secondary: scoreB.secondaryScore }, // 0
  ];
  const result = selectMatchCandidates(tiedCandidates);
  assert.equal(result.length, 1, 'tiebreak should return exactly one candidate');
  assert.equal(result[0].id, 1, 'should return the candidate with higher secondary (date match)');
});
