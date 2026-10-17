/**
 * Each blocker and gap: detected when present, absent when not. Plus the contract
 * the spec cares most about — which items carry a figure and which must not.
 *
 * A test demanding an estimate per item is the instruction that manufactures the
 * fabricated numbers this design twice demoted an item for, so the no-figure cases
 * are asserted as explicitly as the figure cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { ratesFor } from '../engine/brackets';
import { DETECTORS } from './detectors';
import type {
  CompletenessContext, CompletenessItem, CompletenessTxn,
} from './types';
import type { TaxYearFacts } from '../engine/types';

function facts(over: Partial<TaxYearFacts> = {}): TaxYearFacts {
  return {
    year: 2026, jurisdiction: 'CA-ON',
    employmentIncome: [], selfEmploymentIncome: [], selfEmploymentExpenses: [],
    interestIncome: [], eligibleDividends: [], nonEligibleDividends: [],
    capitalGainEvents: [], rrspContribs: [], fhsaContribs: [], donations: [],
    rentalIncome: [], rentalExpenses: [], medicalExpenses: [], slips: [],
    carryforwards: {
      netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'),
      instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0'), fhsaRoom: D('0'),
    },
    ageAtYearEnd: 40, ...over,
  } as TaxYearFacts;
}

function txn(over: Partial<CompletenessTxn> & Pick<CompletenessTxn, 'id'>): CompletenessTxn {
  const base = {
    accountId: 14, date: '2026-03-01', amount: '-1000', txnType: null,
    linkedTransactionId: null, isLinkTarget: false, taxTreatmentOverride: null,
    isTaxClassified: false, counterpartIsCorp: false,
    ...over,
  };
  // cadAmount tracks amount unless a case sets it deliberately. The detectors sum the
  // CAD figure, so a fixture whose two fields disagree silently tests neither.
  return { ...base, cadAmount: over.cadAmount ?? D(base.amount) };
}

/** A context with nothing wrong. Each case perturbs exactly one thing. */
function healthy(over: Partial<CompletenessContext> = {}): CompletenessContext {
  return {
    entityId: 1,
    year: 2026,
    facts: facts(),
    rates: ratesFor(2026),
    personalTxns: [],
    unimportedOutboundTransfers: [],
    accounts: [],
    activities: [],
    duplicates: {
      period: { startDate: '2026-01-01', endDate: '2026-12-31' },
      groups: [], certain: [], review: [], totalDuplicatedAmount: '0.00',
    },
    // `asOfYear = N` is consumed by year N+1, so a healthy 2026 return reads 2025.
    carryforwardYears: [2025],
    slipTypes: ['T5'],
    unreconciledSlips: [],
    unverifiedEligibility: [],
    now: new Date('2026-09-29T00:00:00Z'),
    ...over,
  };
}

const run = (ctx: CompletenessContext): CompletenessItem[] =>
  DETECTORS.flatMap((d) => d(ctx));

const kinds = (ctx: CompletenessContext): string[] => run(ctx).map((i) => i.kind);
const only = (ctx: CompletenessContext, kind: string): CompletenessItem => {
  const found = run(ctx).filter((i) => i.kind === kind);
  assert.equal(found.length, 1, `expected exactly one ${kind}, got ${kinds(ctx).join(', ')}`);
  return found[0];
};

test('a healthy year produces no items at all', () => {
  assert.deepEqual(kinds(healthy()), []);
});

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

const UNCLASSIFIED_DRAW = healthy({
  facts: facts({ nonEligibleDividends: [{ source: 'CDG', amount: D('67000'), cadAmount: D('67000') }] }),
  personalTxns: [
    txn({ id: 10, amount: '10000', txnType: 'transfer', linkedTransactionId: 500, counterpartIsCorp: true }),
    txn({ id: 11, amount: '5000', txnType: 'transfer', linkedTransactionId: 501, counterpartIsCorp: true }),
  ],
});

test('unclassified corp draws: detected, summed, and priced', () => {
  const item = only(UNCLASSIFIED_DRAW, 'unclassified_corp_draws');
  assert.equal(item.severity, 'blocker');
  assert.equal(item.amount, '15000.00');
  // $15,000 on top of $67,000 — the measured $3,041.80.
  assert.equal(item.taxEstimate, '3041.80');
  assert.deepEqual(item.references, [10, 11]);
});

test('unclassified corp draws: a classified row is not counted', () => {
  // Classified through any of the four routes, override null included.
  const ctx = healthy({
    personalTxns: [txn({
      id: 10, amount: '10000', txnType: 'transfer', linkedTransactionId: 500,
      counterpartIsCorp: true, isTaxClassified: true,
    })],
  });
  assert.ok(!kinds(ctx).includes('unclassified_corp_draws'));
});

test('unclassified corp draws: a non-corp counterpart is not counted', () => {
  const ctx = healthy({
    personalTxns: [txn({
      id: 10, amount: '10000', txnType: 'transfer', linkedTransactionId: 500,
      counterpartIsCorp: false,
    })],
  });
  assert.ok(!kinds(ctx).includes('unclassified_corp_draws'));
});

test('unimported outbound corp transfers: amount, and deliberately no estimate', () => {
  const ctx = healthy({
    unimportedOutboundTransfers: [
      { id: 900, date: '2026-04-01', cadAmount: D('-15000') },
    ],
  });
  const item = only(ctx, 'unimported_outbound_corp_transfer');
  assert.equal(item.severity, 'blocker');
  assert.equal(item.amount, '15000.00');
  assert.equal(item.taxEstimate, null, 'pricing it would assume the money reached Connor');
  assert.match(item.detail, /may be a draw/i);
});

test('convertible cash legs: an allowlisted type on an opt-in account blocks', () => {
  const ctx = healthy({
    activities: [{
      id: 70, accountId: 13, activityType: 'transfer_in', amount: '7500',
      date: '2026-02-03', securityId: null, accountType: 'investment', cadAmount: D('7500'), hasTransaction: false,
    }],
  });
  const item = only(ctx, 'convertible_cash_leg_activity');
  assert.equal(item.severity, 'blocker');
  assert.equal(item.amount, '7500.00');
  assert.equal(item.taxEstimate, null);
});

test('convertible cash legs: an activity that already has a transaction is silent', () => {
  const ctx = healthy({
    activities: [{
      id: 70, accountId: 13, activityType: 'transfer_in', amount: '7500',
      date: '2026-02-03', securityId: null, accountType: 'investment', cadAmount: D('7500'), hasTransaction: true,
    }],
  });
  assert.deepEqual(kinds(ctx), []);
});

test('convertible cash legs: a share transfer is not a cash leg', () => {
  // The securityId gate. Without it an in-kind transfer invents cash that never moved.
  const ctx = healthy({
    activities: [{
      id: 70, accountId: 13, activityType: 'transfer_in', amount: '12345',
      date: '2026-02-03', securityId: 42, accountType: 'investment', cadAmount: D('12345'), hasTransaction: false,
    }],
  });
  assert.deepEqual(kinds(ctx), []);
});

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

test('truncated import: one quiet account among active ones, no figure', () => {
  const ctx = healthy({
    accounts: [
      { id: 24, name: 'WS Corporate Chequing', accountType: 'checking', closedAt: null, mergedIntoId: null },
      { id: 14, name: 'WS Chequing', accountType: 'checking', closedAt: null, mergedIntoId: null },
    ],
    personalTxns: [
      txn({ id: 1, accountId: 24, date: '2026-08-13' }),
      txn({ id: 2, accountId: 14, date: '2026-09-25' }),
    ],
  });
  const item = only(ctx, 'truncated_import');
  assert.equal(item.severity, 'gap');
  assert.equal(item.amount, null, 'bounding this needs a run rate over a window that may be quiet');
  assert.equal(item.taxEstimate, null);
  assert.deepEqual(item.references, [24]);
});

test('truncated import: every account quiet at once is ONE lag item, not N', () => {
  // Connor's own doctrine: N per-account gaps for one lagging export is noise.
  const ctx = healthy({
    accounts: [
      { id: 24, name: 'A', accountType: 'checking', closedAt: null, mergedIntoId: null },
      { id: 14, name: 'B', accountType: 'checking', closedAt: null, mergedIntoId: null },
      { id: 15, name: 'C', accountType: 'credit', closedAt: null, mergedIntoId: null },
    ],
    personalTxns: [
      txn({ id: 1, accountId: 24, date: '2026-07-20' }),
      txn({ id: 2, accountId: 14, date: '2026-07-25' }),
      txn({ id: 3, accountId: 15, date: '2026-07-28' }),
    ],
  });
  assert.deepEqual(kinds(ctx), ['export_lag']);
});

test('truncated import: closed and merged accounts are excluded', () => {
  const ctx = healthy({
    accounts: [
      { id: 24, name: 'Closed', accountType: 'checking', closedAt: '2026-02-01', mergedIntoId: null },
      { id: 25, name: 'Merged', accountType: 'checking', closedAt: null, mergedIntoId: 14 },
    ],
    personalTxns: [
      txn({ id: 1, accountId: 24, date: '2026-01-15' }),
      txn({ id: 2, accountId: 25, date: '2026-01-15' }),
    ],
  });
  assert.deepEqual(kinds(ctx), []);
});

test('truncated import: investment and savings accounts are never flagged', () => {
  // Event-driven by nature. A brokerage that posts nothing for three months is normal.
  const ctx = healthy({
    accounts: [
      { id: 13, name: 'Investing', accountType: 'investment', closedAt: null, mergedIntoId: null },
      { id: 16, name: 'Save', accountType: 'savings', closedAt: null, mergedIntoId: null },
    ],
    personalTxns: [
      txn({ id: 1, accountId: 13, date: '2026-01-15' }),
      txn({ id: 2, accountId: 16, date: '2026-01-15' }),
    ],
  });
  assert.deepEqual(kinds(ctx), []);
});

test('truncated import: a recently posting account is silent', () => {
  const ctx = healthy({
    accounts: [{ id: 14, name: 'B', accountType: 'checking', closedAt: null, mergedIntoId: null }],
    personalTxns: [txn({ id: 1, accountId: 14, date: '2026-09-20' })],
  });
  assert.deepEqual(kinds(ctx), []);
});

test('orphaned cash legs: a bare transfer on an opt-in account is a gap with its amount', () => {
  // The most tax-relevant residue: 1a declines to convert it because it might be a draw.
  const ctx = healthy({
    activities: [{
      id: 80, accountId: 13, activityType: 'transfer', amount: '9000',
      date: '2026-05-01', securityId: null, accountType: 'investment', cadAmount: D('9000'), hasTransaction: false,
    }],
  });
  const item = only(ctx, 'orphaned_cash_leg_activity');
  assert.equal(item.severity, 'gap');
  assert.equal(item.amount, '9000.00');
  assert.equal(item.taxEstimate, null);
});

test('orphaned cash legs: an allowlisted type OUTSIDE the opt-in set is a gap', () => {
  const ctx = healthy({
    activities: [{
      id: 81, accountId: 99, activityType: 'transfer_in', amount: '500',
      date: '2026-05-01', securityId: null, accountType: 'investment', cadAmount: D('500'), hasTransaction: false,
    }],
  });
  assert.deepEqual(kinds(ctx), ['orphaned_cash_leg_activity']);
});

test('orphaned cash legs: the blocker and the gap partition, never overlap', () => {
  const ctx = healthy({
    activities: [
      { id: 70, accountId: 13, activityType: 'transfer_in', amount: '7500', date: '2026-02-03', securityId: null, accountType: 'investment', cadAmount: D('7500'), hasTransaction: false },
      { id: 80, accountId: 13, activityType: 'fee', amount: '-10', date: '2026-02-03', securityId: null, accountType: 'investment', cadAmount: D('-10'), hasTransaction: false },
    ],
  });
  const got = run(ctx);
  assert.deepEqual(got.map((i) => i.kind).sort(), ['convertible_cash_leg_activity', 'orphaned_cash_leg_activity']);
  assert.deepEqual(got.find((i) => i.kind === 'convertible_cash_leg_activity')!.references, [70]);
  assert.deepEqual(got.find((i) => i.kind === 'orphaned_cash_leg_activity')!.references, [80]);
});

test('missing T5: dividends counted with no slip, no figure', () => {
  const ctx = healthy({
    facts: facts({ nonEligibleDividends: [{ source: 'CDG', amount: D('92000'), cadAmount: D('92000') }] }),
    slipTypes: [],
  });
  const item = only(ctx, 'missing_t5');
  assert.equal(item.severity, 'gap');
  assert.equal(item.amount, null, 'the income is already counted — there is no missing money');
  assert.equal(item.taxEstimate, null);
});

test('missing T5: silent when the slip is present', () => {
  const ctx = healthy({
    facts: facts({ nonEligibleDividends: [{ source: 'CDG', amount: D('92000'), cadAmount: D('92000') }] }),
    slipTypes: ['T5'],
  });
  assert.deepEqual(kinds(ctx), []);
});

test('missing T5: silent when there are no dividends at all', () => {
  assert.deepEqual(kinds(healthy({ slipTypes: [] })), []);
});

test('uncounted transfer-in: detected, and no figure', () => {
  const ctx = healthy({
    personalTxns: [txn({ id: 12139, amount: '1000', txnType: 'transfer' })],
  });
  const item = only(ctx, 'uncounted_transfer_in');
  assert.equal(item.amount, null, 'money that arrived is not missing money');
  assert.equal(item.taxEstimate, null);
});

test('uncounted transfer-in: a link TARGET is not flagged', () => {
  // The one-directional pointer. Without this every arrival leg in the household fires.
  const ctx = healthy({
    personalTxns: [txn({ id: 12139, amount: '1000', txnType: 'transfer', isLinkTarget: true })],
  });
  assert.deepEqual(kinds(ctx), []);
});

test('unverified eligibility: carries the amount at stake', () => {
  const ctx = healthy({
    unverifiedEligibility: [{ securityId: 5, symbol: 'VFV', amount: '1200' }],
  });
  const item = only(ctx, 'unverified_dividend_eligibility');
  assert.equal(item.amount, '1200.00');
  assert.equal(item.taxEstimate, null, 'the correction can move the total either way');
});

test('duplicate pairs: carries the overstatement', () => {
  const ctx = healthy({
    duplicates: {
      period: { startDate: '2026-01-01', endDate: '2026-12-31' },
      groups: [{ rows: [{ id: 1 }, { id: 2 }] }] as never,
      certain: [{}] as never,
      review: [],
      totalDuplicatedAmount: '17722.35',
    },
  });
  const item = only(ctx, 'duplicate_pairs');
  assert.equal(item.amount, '17722.35');
  assert.equal(item.taxEstimate, null);
});

test('ACB warnings: surfaced, with no figure', () => {
  const ctx = healthy({ facts: facts({ acbWarnings: ['Clamped sell on VFV.'] }) });
  const item = only(ctx, 'acb_warnings');
  assert.equal(item.amount, null);
  assert.match(item.detail, /Clamped sell on VFV/);
});

test('carryforwards not rolled: detected when last year is missing', () => {
  const ctx = healthy({ carryforwardYears: [2023, 2024] });
  const item = only(ctx, 'carryforwards_not_rolled');
  assert.match(item.title, /2024/);
  assert.equal(item.amount, null);
});

test('carryforwards not rolled: silent when last year is present', () => {
  assert.deepEqual(kinds(healthy({ carryforwardYears: [2024, 2025] })), []);
});

test('projected rates: detected for a projected table', () => {
  const ctx = healthy({ rates: { ...ratesFor(2026), provenance: 'projected' } });
  const item = only(ctx, 'projected_rate_table');
  assert.equal(item.amount, null, 'the error is spread across every bracket');
});

test('projected rates: silent for a published table', () => {
  assert.deepEqual(kinds(healthy()), []);
});

test('unreconciled slips: carries the amount', () => {
  const ctx = healthy({
    unreconciledSlips: [{ slipId: 3, slipType: 'T4A', amount: '2500' }],
  });
  const item = only(ctx, 'unreconciled_slips');
  assert.equal(item.amount, '2500.00');
});

// ---------------------------------------------------------------------------
// The figure contract, asserted as a whole
// ---------------------------------------------------------------------------

test('every blocker states an amount', () => {
  // Boundable is what makes it a blocker, so an amount always exists.
  const ctx = healthy({
    personalTxns: [txn({ id: 10, amount: '10000', txnType: 'transfer', linkedTransactionId: 500, counterpartIsCorp: true })],
    unimportedOutboundTransfers: [{ id: 900, date: '2026-04-01', cadAmount: D('-15000') }],
    activities: [{ id: 70, accountId: 13, activityType: 'transfer_in', amount: '7500', date: '2026-02-03', securityId: null, accountType: 'investment', cadAmount: D('7500'), hasTransaction: false }],
  });
  const blockers = run(ctx).filter((i) => i.severity === 'blocker');
  assert.equal(blockers.length, 3);
  for (const b of blockers) assert.ok(b.amount !== null, `${b.kind} has no amount`);
});

test('exactly one item carries a tax estimate, and it is the priced draw', () => {
  // The character of money is known in precisely one case: it came from the corp to
  // Connor. Everything else would be a guess dressed as a number.
  const ctx = healthy({
    personalTxns: [
      txn({ id: 10, amount: '10000', txnType: 'transfer', linkedTransactionId: 500, counterpartIsCorp: true }),
      txn({ id: 11, amount: '1000', txnType: 'transfer' }),
    ],
    unimportedOutboundTransfers: [{ id: 900, date: '2026-04-01', cadAmount: D('-15000') }],
    activities: [{ id: 80, accountId: 13, activityType: 'fee', amount: '-10', date: '2026-02-03', securityId: null, accountType: 'investment', cadAmount: D('-10'), hasTransaction: false }],
    carryforwardYears: [2025],
    slipTypes: [],
    facts: facts({
      nonEligibleDividends: [{ source: 'CDG', amount: D('67000'), cadAmount: D('67000') }],
      acbWarnings: ['x'],
    }),
  });
  const priced = run(ctx).filter((i) => i.taxEstimate !== null);
  assert.deepEqual(priced.map((i) => i.kind), ['unclassified_corp_draws']);
});

test('every item has a fix surface and a non-empty detail', () => {
  const ctx = healthy({
    personalTxns: [txn({ id: 11, amount: '1000', txnType: 'transfer' })],
    facts: facts({ acbWarnings: ['x'] }),
    carryforwardYears: [2025],
    unreconciledSlips: [{ slipId: 3, slipType: 'T4A', amount: '2500' }],
    unverifiedEligibility: [{ securityId: 5, symbol: 'VFV', amount: '1200' }],
  });
  for (const i of run(ctx)) {
    assert.ok(i.fix.surface, `${i.kind} has no fix surface`);
    assert.ok(i.fix.label.length > 0, `${i.kind} has no fix label`);
    assert.ok(i.detail.length > 20, `${i.kind} detail is too thin: ${i.detail}`);
  }
});

test('the priced blocker states the assumption behind its figure', () => {
  // The figure assumes non-eligible dividend treatment. A loan advance or an expense
  // reimbursement is not income at all, so an unqualified number here would be the
  // same sin that leaves the other two blockers unpriced — a figure without its basis.
  const item = only(UNCLASSIFIED_DRAW, 'unclassified_corp_draws');
  assert.ok(item.taxEstimate !== null);
  assert.match(item.detail, /assumes/i);
  assert.match(item.detail, /upper bound/i);
});

test('carryforwards: the year BEFORE this one is what the return reads', () => {
  // `asOfYear = N` means balances at the end of N, consumed by N+1, and
  // `buildPersonalFacts` reads `asOfYear: year - 1`. Demanding ctx.year fired on every
  // correctly maintained ledger — and could not be cleared, because the row only
  // appears once this return has itself been computed and rolled.
  assert.deepEqual(kinds(healthy({ carryforwardYears: [2025] })), []);
});

test('carryforwards: a gap when last year was never rolled', () => {
  const ctx = healthy({ carryforwardYears: [2023, 2024] });
  const item = only(ctx, 'carryforwards_not_rolled');
  assert.match(item.detail, /from 2025/);
});

test('truncated import: a CLOSED year reports nothing, however old its last row', () => {
  // Opening the 2024 return in 2026 flagged every account as quiet, or reported
  // "export lag" for a year that finished 21 months earlier.
  const ctx = healthy({
    year: 2024,
    facts: facts({ year: 2024 }),
    carryforwardYears: [2023],
    accounts: [
      { id: 24, name: 'A', accountType: 'checking', closedAt: null, mergedIntoId: null },
      { id: 14, name: 'B', accountType: 'checking', closedAt: null, mergedIntoId: null },
    ],
    personalTxns: [
      txn({ id: 1, accountId: 24, date: '2024-12-20' }),
      txn({ id: 2, accountId: 14, date: '2024-12-22' }),
    ],
  });
  assert.ok(!kinds(ctx).includes('truncated_import'), kinds(ctx).join(', '));
  assert.ok(!kinds(ctx).includes('export_lag'), kinds(ctx).join(', '));
});

test('unclassified corp draws: money flowing INTO the corp is not a draw', () => {
  // A shareholder-loan advance or capital injection is a personal-entity transfer with
  // a negative amount, linked, corp counterpart, unclassified — it matched every other
  // condition. Its magnitude was then added to "moved from the corporation to you" and
  // priced as a non-eligible dividend.
  const ctx = healthy({
    personalTxns: [
      txn({ id: 10, amount: '10000', txnType: 'transfer', linkedTransactionId: 500, counterpartIsCorp: true }),
      txn({ id: 11, amount: '-10000', txnType: 'transfer', linkedTransactionId: 501, counterpartIsCorp: true }),
    ],
  });
  const item = only(ctx, 'unclassified_corp_draws');
  assert.equal(item.amount, '10000.00', 'the injection must not inflate the draw total');
  assert.deepEqual(item.references, [10]);
});

test('convertible cash legs: a DEPOSIT account orphan blocks, whatever its activity type', () => {
  // The population the converter was built for, and the one the old scoping missed
  // entirely: it required an account in BROKERAGE_CASH_LEG_ACCOUNT_IDS, i.e. account 13
  // alone. On a deposit account no allowlist applies — every security-less row is a cash
  // event — so the blocker read as an all-clear on a ledger whose only orphans were
  // there, and the gap claimed "nothing will convert" about rows that do convert.
  const ctx = healthy({
    activities: [{
      id: 90, accountId: 14, accountType: 'checking', activityType: 'interest',
      amount: '120', cadAmount: D('120'), date: '2026-05-01',
      securityId: null, hasTransaction: false,
    }],
  });
  const item = only(ctx, 'convertible_cash_leg_activity');
  assert.equal(item.severity, 'blocker');
  assert.equal(item.amount, '120.00');
  assert.ok(!kinds(ctx).includes('orphaned_cash_leg_activity'), 'and not also a gap');
});

test('orphaned cash legs: an allowlisted type on an unrelated INVESTMENT account is a gap', () => {
  // Not a deposit account and not opted in, so nothing converts it.
  const ctx = healthy({
    activities: [{
      id: 91, accountId: 99, accountType: 'investment', activityType: 'transfer_in',
      amount: '500', cadAmount: D('500'), date: '2026-05-01',
      securityId: null, hasTransaction: false,
    }],
  });
  assert.deepEqual(kinds(ctx), ['orphaned_cash_leg_activity']);
});

test('every cash-leg orphan lands in exactly one of the two items', () => {
  // They are complements now, so no row can fall between them — a row reported by
  // neither was the third of the three failures here.
  const rows = [
    { id: 1, accountId: 13, accountType: 'investment', activityType: 'transfer_in', amount: '10', cadAmount: D('10') },
    { id: 2, accountId: 13, accountType: 'investment', activityType: 'fee', amount: '20', cadAmount: D('20') },
    { id: 3, accountId: 14, accountType: 'checking', activityType: 'interest', amount: '30', cadAmount: D('30') },
    { id: 4, accountId: 99, accountType: 'investment', activityType: 'transfer_out', amount: '40', cadAmount: D('40') },
    { id: 5, accountId: 99, accountType: 'investment', activityType: 'fee', amount: '50', cadAmount: D('50') },
  ].map((r) => ({ ...r, date: '2026-05-01', securityId: null, hasTransaction: false }));
  const got = run(healthy({ activities: rows }));
  const covered = got
    .filter((i) => i.kind.endsWith('cash_leg_activity'))
    .flatMap((i) => i.references)
    .sort((a, b) => a - b);
  assert.deepEqual(covered, [1, 2, 3, 4, 5]);
});

test('a USD cash-leg orphan is reported in CAD', () => {
  const ctx = healthy({
    activities: [{
      id: 92, accountId: 14, accountType: 'checking', activityType: 'interest',
      amount: '100', cadAmount: D('140'), date: '2026-05-01',
      securityId: null, hasTransaction: false,
    }],
  });
  assert.equal(only(ctx, 'convertible_cash_leg_activity').amount, '140.00');
});

test('the outbound corp blocker reports CAD, not the account currency', () => {
  // PerimeterTxn.amount is in the account's own currency — the corp's Wise USD account
  // is that module's own worked example — and this is a blocker's headline figure.
  const ctx = healthy({
    unimportedOutboundTransfers: [{ id: 900, date: '2026-04-01', cadAmount: D('-21000') }],
  });
  assert.equal(only(ctx, 'unimported_outbound_corp_transfer').amount, '21000.00');
});
