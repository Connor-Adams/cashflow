// backend/src/amazon/matcher.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Transaction, ExternalOrder, TransactionOrderLink, Household, Account } from '../models';
import { runAmazonMatching, scoreAmazonOrderMatch, selectMatchCandidates, isTopTied } from './matcher';

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

  const result = scoreAmazonOrderMatch(txn, orderWithDate, null);
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

  const result = scoreAmazonOrderMatch(txn, orderWithLast4, '1234');
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

  const result = scoreAmazonOrderMatch(txn, orderBoth, '1234');
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
    total: '49.60', // within $0.50 but not exact-cent → +50 confidence, no secondary
    orderDate: '2026-05-01', // far away — date gap > 10 days, no secondary
    shipmentDate: null,
    paymentLast4: null,
  } as unknown as ExternalOrder;

  const result = scoreAmazonOrderMatch(txn, orderAmountOnly, null);
  assert.equal(
    result.secondaryScore,
    0,
    'a near-miss (non-exact-cent) amount match should have zero secondary score',
  );
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

  const scoreA = scoreAmazonOrderMatch(txn, orderDateMatch, null);
  const scoreB = scoreAmazonOrderMatch(txn, orderNoDate, null);

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

// ─── exact-cent scoring band for undated orders ──────────────────────────────
// 30 of 60 unmatched Amazon transactions have an order in the corpus with the
// correct total to the cent, but the order has no order_date, so it scores 65
// (50 amount + 15 merchant) — tying against near-miss orders that also score
// 65 — and selectMatchCandidates abstains on the tie. An exact-cent match must
// credit secondaryScore (not confidence) so the existing tie guard resolves it,
// without pushing the candidate into the ungated `strong` tier.

const exactCentTxn = {
  amount: '-44.97',
  date: '2025-08-28',
  merchantRaw: 'AMZN MKTP CA*Z90R91K22',
  merchantClean: 'Amazon',
  notes: null,
  sourceReference: null,
  accountId: 1,
} as unknown as Transaction;

const undatedOrder = (total: string) =>
  ({ total, orderDate: null, shipmentDate: null, paymentLast4: null, currency: 'CAD' } as unknown as ExternalOrder);

test('an exact-cent amount match credits secondaryScore', () => {
  const exact = scoreAmazonOrderMatch(exactCentTxn, undatedOrder('44.97'), null);
  assert.equal(exact.secondaryScore >= 20, true, 'exact cent match scores on secondary');
  assert.match(exact.matchReason, /to the cent/);
});

test('a near-miss inside $0.50 does NOT credit secondaryScore', () => {
  const near = scoreAmazonOrderMatch(exactCentTxn, undatedOrder('44.70'), null);
  assert.equal(near.secondaryScore, 0);
});

test('exact-cent and near-miss tie on confidence but the exact one wins', () => {
  const exact = scoreAmazonOrderMatch(exactCentTxn, undatedOrder('44.97'), null);
  const near = scoreAmazonOrderMatch(exactCentTxn, undatedOrder('44.70'), null);
  assert.equal(exact.confidence, near.confidence, 'both score 65 — this is the tie that used to abstain');

  const picked = selectMatchCandidates([
    { id: 'near', confidence: near.confidence, secondary: near.secondaryScore },
    { id: 'exact', confidence: exact.confidence, secondary: exact.secondaryScore },
  ]);
  assert.equal(picked.length, 1);
  assert.equal((picked[0] as { id: string }).id, 'exact');
});

test('an undated exact-cent order stays below the strong threshold', () => {
  const exact = scoreAmazonOrderMatch(exactCentTxn, undatedOrder('44.97'), null);
  assert.equal(exact.confidence < 70, true, 'must stay in the fallback tier — fan-out guard');
});

test('two exact-cent orders abstain rather than fan out', () => {
  const a = scoreAmazonOrderMatch(exactCentTxn, undatedOrder('44.97'), null);
  const b = scoreAmazonOrderMatch(exactCentTxn, undatedOrder('44.97'), null);
  const picked = selectMatchCandidates([
    { id: 'a', confidence: a.confidence, secondary: a.secondaryScore },
    { id: 'b', confidence: b.confidence, secondary: b.secondaryScore },
  ]);
  assert.equal(picked.length, 0, 'ambiguous — abstain');
});

// ─── account-derived last4 bonus + strong-tier tie guard (Task 11) ───────────
// last4FromText scraped txn.notes/sourceReference and matched 0 of 111
// production Amazon transactions. The card last4 actually lives on the
// transaction's account (accounts.short_code), resolved via
// resolveAccountLast4 and threaded in as scoreAmazonOrderMatch's third
// parameter. Turning this signal on pushes an undated exact-cent match from
// 65 into the strong tier (50 + 15 + 20 = 85), so these tests also cover the
// strong-tier tie guard that keeps that from fanning out.

test('the last4 bonus comes from the account, not from txn text', () => {
  const order = {
    total: '44.97',
    orderDate: '2025-08-27',
    shipmentDate: null,
    paymentLast4: '1001',
    currency: 'CAD',
  } as never;
  const withAccount = scoreAmazonOrderMatch(exactCentTxn, order, '1001');
  const withoutAccount = scoreAmazonOrderMatch(exactCentTxn, order, null);
  assert.equal(withAccount.confidence > withoutAccount.confidence, true);
  assert.match(withAccount.matchReason, /last4 matches/);
});

test('two exact-cent orders on the SAME card abstain instead of fanning out', () => {
  // Both score 50 + 15 + 20 = 85, which clears the strong threshold.
  const order = {
    total: '44.97',
    orderDate: null,
    shipmentDate: null,
    paymentLast4: '1001',
    currency: 'CAD',
  } as never;
  const a = scoreAmazonOrderMatch(exactCentTxn, order, '1001');
  const b = scoreAmazonOrderMatch(exactCentTxn, order, '1001');
  assert.equal(a.confidence >= 70, true, 'precondition: these are in the strong tier');

  const picked = selectMatchCandidates([
    { id: 'a', confidence: a.confidence, secondary: a.secondaryScore },
    { id: 'b', confidence: b.confidence, secondary: b.secondaryScore },
  ]);
  assert.equal(picked.length, 0, 'strong-tier tie must abstain, not fan out');
});

test('a genuine multi-order charge at different strong scores still returns all', () => {
  const picked = selectMatchCandidates([
    { id: 'a', confidence: 90, secondary: 20 },
    { id: 'b', confidence: 75, secondary: 0 },
  ]);
  assert.equal(picked.length, 2, 'different scores — not a tie, preserve multi-order behaviour');
});

test('a resolvable strong tie keeps the winner plus strictly-lower candidates', () => {
  const picked = selectMatchCandidates([
    { id: 'tieWinner', confidence: 85, secondary: 20 },
    { id: 'tieLoser', confidence: 85, secondary: 0 },
    { id: 'lower', confidence: 75, secondary: 0 },
  ]);
  assert.deepEqual(picked.map((p) => (p as { id: string }).id).sort(), ['lower', 'tieWinner']);
});

test('a last4 mismatch is penalised', () => {
  const txn = {
    amount: '-44.97',
    date: '2025-08-28',
    merchantRaw: 'AMZN MKTP CA*Z90R91K22',
    merchantClean: 'Amazon',
    notes: null,
    sourceReference: null,
    accountId: 1,
  } as unknown as Transaction;
  const order = { total: '44.97', orderDate: '2025-08-27', shipmentDate: null, paymentLast4: '2662', currency: 'CAD' } as never;
  const mismatch = scoreAmazonOrderMatch(txn, order, '1001');
  const noTxnLast4 = scoreAmazonOrderMatch(txn, order, null);
  assert.equal(mismatch.confidence < noTxnLast4.confidence, true);
  assert.match(mismatch.matchReason, /different card/);
});

test('no penalty when either side lacks a last4', () => {
  const txn = {
    amount: '-44.97',
    date: '2025-08-28',
    merchantRaw: 'AMZN MKTP CA*Z90R91K22',
    merchantClean: 'Amazon',
    notes: null,
    sourceReference: null,
    accountId: 1,
  } as unknown as Transaction;
  const orderNoLast4 = { total: '44.97', orderDate: '2025-08-27', shipmentDate: null, paymentLast4: null, currency: 'CAD' } as never;
  const a = scoreAmazonOrderMatch(txn, orderNoLast4, '1001');
  const b = scoreAmazonOrderMatch(txn, orderNoLast4, null);
  assert.equal(a.confidence, b.confidence, 'absence of evidence is not evidence');
});

// ─── Task 17: Prime membership charge filtering ────────────────────────────
// See ./merchant.test.ts for isAmazonSubscriptionCharge / isAmazonLikeMerchant
// coverage — those predicates now live in ./merchant to avoid a circular
// dependency between matcher.ts and backfillAutoAcceptLinks.ts.

// ─── FIX 1: a tie-resolved selection must not auto-accept ───────────────────
//
// selectMatchCandidates collapses a resolved strong-tier tie down to just the
// winner when there are no strictly-lower candidates — indistinguishable from
// a genuine lone match by candidates.length alone. isTopTied lets a caller
// tell the two apart using the pre-selection scored list.

test('isTopTied is true when the top strong score is a tie', () => {
  const scores = [
    { confidence: 85, secondary: 40 },
    { confidence: 85, secondary: 20 },
  ];
  assert.equal(isTopTied(scores), true);
  // selectMatchCandidates still collapses this to the sole winner.
  assert.equal(selectMatchCandidates(scores).length, 1);
});

test('isTopTied is false for a genuine lone strong candidate', () => {
  assert.equal(isTopTied([{ confidence: 90 }]), false);
});

test('isTopTied is false when strong candidates differ (not a tie)', () => {
  assert.equal(isTopTied([{ confidence: 90 }, { confidence: 75 }]), false);
});

test('isTopTied considers the fallback tier when nothing is strong', () => {
  assert.equal(isTopTied([{ confidence: 50 }, { confidence: 50 }]), true);
  assert.equal(isTopTied([{ confidence: 50 }, { confidence: 30 }]), false);
});

test(
  'runAmazonMatching: a tie resolved by secondary score is suggested, never auto-accepted',
  async () => {
    // Concrete repro from the final-review finding: txn on an Amex Reserve
    // (short_code 701001 -> last4 1001) for $44.97. Order A (undated, total
    // 44.97, last4 1001) scores 85 with secondary 40 (exact-cent + last4).
    // Order B (undated, total 45.40, last4 1001) also scores 85, secondary 20
    // (within-$0.50 + last4). A wins the tie on secondary, but pre-branch
    // decideAutoAccept([85, 85]) was false — this must stay suggested, not
    // silently promoted to accepted just because the tie resolved to a
    // single surviving candidate.
    const householdId = 9101;
    const household = await Household.create({ id: householdId, name: `HH-${householdId}` } as never);
    const account = await Account.create({
      householdId: household.id,
      name: 'Amex Reserve',
      shortCode: '701001',
    } as never);
    const txn = await Transaction.create({
      householdId: household.id,
      accountId: account.id,
      date: '2026-06-10',
      amount: '-44.97',
      currency: 'CAD',
      merchantRaw: 'AMAZON.CA',
      merchantClean: 'Amazon',
      txnType: 'purchase',
      importBatch: 'test',
      sourceRowFingerprint: `srfp-${householdId}`,
      sourceIdentityFingerprint: `sifp-${householdId}`,
    } as never);
    const orderA = await ExternalOrder.create({
      householdId: household.id,
      vendor: 'amazon',
      orderDate: null,
      total: '44.97',
      currency: 'CAD',
      paymentLast4: '1001',
      source: 'test',
      dedupeKey: `t-${householdId}-a`,
    } as never);
    const orderB = await ExternalOrder.create({
      householdId: household.id,
      vendor: 'amazon',
      orderDate: null,
      total: '45.40',
      currency: 'CAD',
      paymentLast4: '1001',
      source: 'test',
      dedupeKey: `t-${householdId}-b`,
    } as never);

    const res = await runAmazonMatching({ householdId });

    assert.equal(res.autoAccepted, 0, 'an ambiguous tied pair must never auto-accept');
    const linkA = await TransactionOrderLink.findOne({
      where: { transactionId: (txn as { id: number }).id, externalOrderId: (orderA as { id: number }).id },
    });
    assert.equal(linkA?.status, 'suggested', 'the tie winner is suggested, not accepted');
    const linkB = await TransactionOrderLink.findOne({
      where: { transactionId: (txn as { id: number }).id, externalOrderId: (orderB as { id: number }).id },
    });
    assert.equal(linkB, null, 'the tie loser gets no link at all (unchanged fan-out guard)');
  },
);

test(
  'runAmazonMatching: an unresolvable tie on a later run must not promote an earlier run\'s resolved-tie link',
  async () => {
    // Final-review finding: resolveTie returns [] (not a singleton) when TWO OR
    // MORE candidates share the best secondary score, so selectMatchCandidates
    // returns [] and candidates.length === 0 for that transaction. The old guard
    // `candidates.length === 1 && tied` only fires on the length-1 case, so this
    // 0-candidate tie was never added to tieAmbiguousTxnIds — leaving a
    // `suggested` link from an earlier, resolvable run free for the backfill to
    // promote, even though the identity is now MORE ambiguous, not less.
    //
    // Night 1: orders A (44.97, exact-cent, secondary 40) and B (45.40,
    // within-$0.50, secondary 20) both tie at confidence 85; A wins on
    // secondary and is linked `suggested`.
    // Night 2: a repeat order C (also 44.97, secondary 40) imports. Now A and C
    // tie for the best secondary score too -> resolveTie returns [] ->
    // candidates.length === 0. The transaction must still be excluded from the
    // backfill, so link A stays `suggested`.
    const householdId = 9102;
    const household = await Household.create({ id: householdId, name: `HH-${householdId}` } as never);
    const account = await Account.create({
      householdId: household.id,
      name: 'Amex Reserve',
      shortCode: '701001',
    } as never);
    const txn = await Transaction.create({
      householdId: household.id,
      accountId: account.id,
      date: '2026-06-10',
      amount: '-44.97',
      currency: 'CAD',
      merchantRaw: 'AMAZON.CA',
      merchantClean: 'Amazon',
      txnType: 'purchase',
      importBatch: 'test',
      sourceRowFingerprint: `srfp-${householdId}`,
      sourceIdentityFingerprint: `sifp-${householdId}`,
    } as never);
    const orderA = await ExternalOrder.create({
      householdId: household.id,
      vendor: 'amazon',
      orderDate: null,
      total: '44.97',
      currency: 'CAD',
      paymentLast4: '1001',
      source: 'test',
      dedupeKey: `t-${householdId}-a`,
    } as never);
    await ExternalOrder.create({
      householdId: household.id,
      vendor: 'amazon',
      orderDate: null,
      total: '45.40',
      currency: 'CAD',
      paymentLast4: '1001',
      source: 'test',
      dedupeKey: `t-${householdId}-b`,
    } as never);

    // Night 1: resolvable tie — A wins on secondary score, suggested (not accepted).
    const first = await runAmazonMatching({ householdId });
    assert.equal(first.autoAccepted, 0, 'night 1 tie must never auto-accept');
    const linkAAfterFirst = await TransactionOrderLink.findOne({
      where: { transactionId: (txn as { id: number }).id, externalOrderId: (orderA as { id: number }).id },
    });
    assert.equal(linkAAfterFirst?.status, 'suggested', 'night 1 winner is suggested, not accepted');

    // Night 2: a colliding repeat order C imports, making the tie unresolvable.
    await ExternalOrder.create({
      householdId: household.id,
      vendor: 'amazon',
      orderDate: null,
      total: '44.97',
      currency: 'CAD',
      paymentLast4: '1001',
      source: 'test',
      dedupeKey: `t-${householdId}-c`,
    } as never);

    const second = await runAmazonMatching({ householdId });
    assert.equal(
      second.autoAccepted,
      0,
      'a MORE ambiguous unresolvable tie must never auto-accept what a resolvable tie refused',
    );
    const linkAAfterSecond = await TransactionOrderLink.findOne({
      where: { transactionId: (txn as { id: number }).id, externalOrderId: (orderA as { id: number }).id },
    });
    assert.equal(
      linkAAfterSecond?.status,
      'suggested',
      'link A must still be suggested — the backfill must not have promoted it',
    );
  },
);
