import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionCorpPerimeter, type PerimeterTxn } from './corpPerimeter';

// The corp's real revenue chain looks like this in the ledger, one row per hop:
//
//   Wise USD in   "Received money from WANDERCOM"      <- external, unlinked
//   Wise USD out                                       -> linked
//   Wise CAD in   "Converted 5,207.60 USD to 7,125.92" -> linked (FX pair)
//   Wise CAD out  "Sent money to CDG Labs Inc."        -> linked to the arrival
//   RBC in        "Misc Payment CDG LABS INC"          <- link TARGET, no back-pointer
//
// Only the first hop is revenue. `linked_transaction_id` is one-directional,
// so "unlinked" alone is not enough — the arrival leg is unlinked too. A row
// crossed the corp perimeter only if it is NEITHER a link source NOR a link
// target.

function txn(over: Partial<PerimeterTxn> & { id: number; amount: string }): PerimeterTxn {
  return {
    currency: 'CAD',
    date: '2026-03-13',
    txnType: 'transfer',
    accountType: 'checking',
    linkedTransactionId: null,
    taxTreatmentOverride: null,
    merchant: null,
    ...over,
  };
}

const LEGAL_NAME = 'CDG LABS INC.';

test('counts an external receipt as revenue', () => {
  const rows = [
    txn({ id: 1, amount: '5207.60', currency: 'USD', merchant: 'Received money from WANDERCOM with reference' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue.map((r) => r.id), [1]);
  assert.deepEqual(out.warnings, []);
});

test('drops every internal hop of a transfer chain', () => {
  const rows = [
    txn({ id: 1, amount: '5207.60', currency: 'USD', merchant: 'Received money from WANDERCOM with reference' }),
    txn({ id: 2, amount: '-5207.60', currency: 'USD', linkedTransactionId: 3 }), // Wise USD out
    txn({ id: 3, amount: '7125.92', merchant: 'Converted 5,207.60 USD to 7,125.92 CAD', linkedTransactionId: 2 }),
    txn({ id: 4, amount: '-7125.92', merchant: 'Sent money to CDG Labs Inc.', linkedTransactionId: 5 }),
    txn({ id: 5, amount: '7125.92', txnType: 'unknown', merchant: 'Misc Payment CDG LABS INC' }), // arrival: link TARGET
  ];
  const linkTargetIds = new Set([3, 2, 5]);
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds });
  assert.deepEqual(out.revenue.map((r) => r.id), [1], 'only the external receipt is revenue');
  assert.deepEqual(out.expenses.map((r) => r.id), [], 'internal legs are not expenses either');
});

test('warns on an orphaned arrival leg but still counts it', () => {
  // The upstream Wise rows were never imported, so this arrival is a link
  // target of nothing and looks external. Counting it keeps the year from
  // silently understating; the warning says the number is load-bearing.
  const rows = [
    txn({ id: 9, amount: '14891.99', txnType: 'income', merchant: 'Direct deposit from CDG LABS INC' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue.map((r) => r.id), [9]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /#9/);
  assert.match(out.warnings[0], /14891\.99/);
});

test('warns on a perimeter receipt with no counterparty named', () => {
  const rows = [txn({ id: 10, amount: '14500.00', merchant: 'Deposit' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue.map((r) => r.id), [10]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /#10/);
});

test('routes bank-account interest to investment income, not active business income', () => {
  // Corp chequing pays interest monthly. It is passive income, and no
  // InvestmentActivity row exists for a chequing account, so the transaction
  // is the only record of it.
  const rows = [txn({ id: 12, amount: '30.91', txnType: 'interest', merchant: 'Interest received' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue, [], 'not active business income');
  assert.deepEqual(out.interestIncome.map((r) => r.id), [12]);
  assert.deepEqual(out.warnings, []);
});

test('routes bank-account dividends to investment income', () => {
  const rows = [txn({ id: 11, amount: '77.60', txnType: 'dividend', merchant: 'Patronage dividend' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue, []);
  assert.deepEqual(out.dividendIncome.map((r) => r.id), [11]);
});

test('drops passive rows on investment accounts — InvestmentActivity owns those', () => {
  // A brokerage reports the same distribution twice: once as an
  // InvestmentActivity row (which carries the security, and therefore the
  // eligibility) and once as a cash transaction. Counting both doubles it.
  const rows = [
    txn({ id: 13, amount: '151.23', txnType: 'dividend', accountType: 'investment', merchant: 'XEQT cash dividend distribution' }),
    txn({ id: 14, amount: '0.01', txnType: 'interest', accountType: 'investment', merchant: 'Stock lending monthly interest payment' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue, []);
  assert.deepEqual(out.interestIncome, []);
  assert.deepEqual(out.dividendIncome, []);
});

test('a passive row that is an internal transfer leg is still dropped', () => {
  const rows = [txn({ id: 15, amount: '30.91', txnType: 'interest', linkedTransactionId: 99 })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.interestIncome, []);
});

test('a negative passive row keeps its sign so reversals net off', () => {
  const rows = [txn({ id: 16, amount: '-2.27', txnType: 'interest', merchant: 'Interest reversal' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.interestIncome.map((r) => r.id), [16], 'nets against interest, not deducted as an expense');
  assert.deepEqual(out.expenses, []);
});

test('excludes rows already consumed as distributions or shareholder loans', () => {
  const rows = [
    txn({ id: 13, amount: '-4100.00', taxTreatmentOverride: 'non_eligible_dividend' }),
    txn({ id: 14, amount: '-5000.00', taxTreatmentOverride: 'salary' }),
    txn({ id: 15, amount: '-5000.00', taxTreatmentOverride: 'employment_income' }),
    txn({ id: 16, amount: '2000.00', taxTreatmentOverride: 'loan_repayment' }),
    txn({ id: 17, amount: '-0.20', taxTreatmentOverride: 'not_income' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue, []);
  assert.deepEqual(out.expenses, []);
});

test('counts an external outflow as a deductible expense', () => {
  const rows = [txn({ id: 18, amount: '-6.00', txnType: 'fee', merchant: 'cc fee' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.expenses.map((r) => r.id), [18]);
});

test('excludes investment purchases from expenses (capital deployment, not a cost)', () => {
  const rows = [txn({ id: 19, amount: '-9999.41', txnType: 'investment', merchant: 'Buy VFV' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.expenses, []);
});

test('zero-amount rows land in neither bucket', () => {
  const rows = [txn({ id: 20, amount: '0.00' })];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue, []);
  assert.deepEqual(out.expenses, []);
});

// An outbound row typed `transfer` is, by definition, half of a pair. Reaching
// the perimeter means its other half was never imported — it is your own money
// moving, not a cost of doing business. Deducting it would understate income,
// so it is dropped and called out. (Inbound transfers are NOT symmetric: Wise
// labels genuine customer payments `transfer`, so those still count.)
test('drops an outbound transfer with no imported pair, and says so', () => {
  const rows = [
    txn({
      id: 21,
      amount: '-10000.00',
      txnType: 'transfer',
      merchant: 'Tax-free money transfer out of the account',
    }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.expenses, [], 'not a deductible expense');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /#21/);
  assert.match(out.warnings[0], /not deducted/i);
});

test('an inbound transfer from a named external payer is still revenue', () => {
  const rows = [
    txn({ id: 22, amount: '5207.60', currency: 'USD', txnType: 'transfer', merchant: 'Received money from WANDERCOM' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.revenue.map((r) => r.id), [22]);
  assert.deepEqual(out.warnings, []);
});

test('a passive row tagged not_income is dropped, not bucketed as investment income', () => {
  // Card cash-back posts on the corp chequing ledger worded as interest. It is
  // a rebate on the purchase, not investment income, so tagging it not_income
  // must keep it out of AAII (where it would feed the SBD grind).
  const rows = [
    txn({ id: 23, amount: '27.53', txnType: 'interest', taxTreatmentOverride: 'not_income', merchant: 'Interest earned' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.interestIncome, []);
  assert.deepEqual(out.revenue, []);
});

test('an expense reimbursement is neither corp revenue nor a corp expense', () => {
  // Repaying the owner returns money they already spent. The underlying
  // purchase is what the corp deducts; deducting the repayment too would
  // double it.
  // txnType is deliberately NOT 'transfer' here — otherwise the outbound-
  // transfer rule would exclude it and the test would pass without the
  // treatment doing any work.
  const rows = [
    txn({ id: 24, amount: '-1782.12', txnType: 'purchase', taxTreatmentOverride: 'expense_reimbursement', merchant: 'Reimbursement to owner' }),
  ];
  const out = partitionCorpPerimeter(rows, { legalName: LEGAL_NAME, linkTargetIds: new Set() });
  assert.deepEqual(out.expenses, []);
  assert.deepEqual(out.revenue, []);
});

// --- transfers whose far side is a brokerage cash movement ---
//
// `linked_transaction_id` is a foreign key into transactions, so a transfer
// between a bank account and a brokerage can never be linked: the far side is
// an InvestmentActivity row, not a Transaction. The money IS tracked, just in
// the other ledger — so match against it rather than treating the transfer as
// unexplained.

test('an outbound transfer matching a brokerage transfer_in is internal, silently', () => {
  const rows = [
    txn({
      id: 30, amount: '-10000.00', date: '2026-07-06',
      merchant: 'Tax-free money transfer out of the account',
    }),
  ];
  const out = partitionCorpPerimeter(rows, {
    legalName: LEGAL_NAME,
    linkTargetIds: new Set(),
    internalCashMoves: [{ date: '2026-07-06', amount: '10000.00', currency: 'CAD' }],
  });
  assert.deepEqual(out.expenses, []);
  assert.deepEqual(out.warnings, [], 'the far side is accounted for — nothing to warn about');
});

test('an outbound transfer with no brokerage counterpart still warns', () => {
  const rows = [
    txn({ id: 31, amount: '-14500.00', date: '2026-09-01', merchant: 'Investment WS Investments' }),
  ];
  const out = partitionCorpPerimeter(rows, {
    legalName: LEGAL_NAME,
    linkTargetIds: new Set(),
    internalCashMoves: [{ date: '2026-07-06', amount: '10000.00', currency: 'CAD' }],
  });
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /#31/);
});

test('an inbound row matching a brokerage transfer_out is not revenue', () => {
  // Money coming back out of the brokerage is the corp's own cash returning,
  // not a customer paying.
  const rows = [
    txn({ id: 32, amount: '15000.00', date: '2026-01-10', merchant: 'Deposit' }),
  ];
  const out = partitionCorpPerimeter(rows, {
    legalName: LEGAL_NAME,
    linkTargetIds: new Set(),
    internalCashMoves: [{ date: '2026-01-10', amount: '-15000.00', currency: 'CAD' }],
  });
  assert.deepEqual(out.revenue, []);
  assert.deepEqual(out.warnings, []);
});

test('one brokerage movement explains only one transfer', () => {
  const rows = [
    txn({ id: 33, amount: '-7000.00', date: '2026-03-02', merchant: 'Investment WS Investments' }),
    txn({ id: 34, amount: '-7000.00', date: '2026-03-02', merchant: 'Investment WS Investments' }),
  ];
  const out = partitionCorpPerimeter(rows, {
    legalName: LEGAL_NAME,
    linkTargetIds: new Set(),
    internalCashMoves: [{ date: '2026-03-02', amount: '7000.00', currency: 'CAD' }],
  });
  assert.equal(out.warnings.length, 1, 'the second transfer is still unexplained');
});

test('settlement drift of a few days still matches, a month apart does not', () => {
  const near = partitionCorpPerimeter(
    [txn({ id: 35, amount: '-7000.00', date: '2026-03-02', merchant: 'Investment WS Investments' })],
    {
      legalName: LEGAL_NAME,
      linkTargetIds: new Set(),
      internalCashMoves: [{ date: '2026-03-04', amount: '7000.00', currency: 'CAD' }],
    },
  );
  assert.deepEqual(near.warnings, []);

  const far = partitionCorpPerimeter(
    [txn({ id: 36, amount: '-7000.00', date: '2026-03-02', merchant: 'Investment WS Investments' })],
    {
      legalName: LEGAL_NAME,
      linkTargetIds: new Set(),
      internalCashMoves: [{ date: '2026-04-02', amount: '7000.00', currency: 'CAD' }],
    },
  );
  assert.equal(far.warnings.length, 1);
});

test('a brokerage movement in another currency does not match', () => {
  const out = partitionCorpPerimeter(
    [txn({ id: 37, amount: '-7000.00', currency: 'USD', date: '2026-03-02', merchant: 'Transfer out' })],
    {
      legalName: LEGAL_NAME,
      linkTargetIds: new Set(),
      internalCashMoves: [{ date: '2026-03-02', amount: '7000.00', currency: 'CAD' }],
    },
  );
  assert.equal(out.warnings.length, 1);
});
