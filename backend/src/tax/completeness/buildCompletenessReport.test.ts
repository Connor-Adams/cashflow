/**
 * The completeness report end to end, against a seeded database.
 *
 * The detectors are unit-tested over a synthetic context in `detectors.test.ts`; what
 * this file proves is that the LOADER hands them the right thing — the queries, the
 * four-route classification, the one-directional link resolution, the corp reach.
 *
 * Three cases carry the weight:
 *   - a genuinely complete year says so affirmatively, with a coverage date. "No
 *     warnings" and "nobody checked" must not look the same.
 *   - the report is recomputed when import coverage changes but facts do not. That is
 *     the specific regression that would silently reintroduce a stale gate.
 *   - Connor's real 2026 shape reaches `blocked` with the draws priced.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import {
  Account, Carryforward, Category, Entity, Household, TaxSlip, Transaction,
} from '../../models';
import { D } from '../util/decimal';
import { ratesFor } from '../engine/brackets';
import { buildCompletenessReport } from './buildCompletenessReport';
import type { TaxYearFacts } from '../engine/types';

const NOW = new Date('2026-09-29T00:00:00Z');
let householdId: number;
let personalId: number;
let corpId: number;
let chequingId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  const household = await Household.create({ name: 'HH' });
  householdId = household.id;
  const personal = await Entity.create({
    householdId, kind: 'personal', legalName: 'Connor',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  personalId = personal.id;
  const corp = await Entity.create({
    householdId, kind: 'corp', legalName: 'CDG Inc.',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  corpId = corp.id;
  const chequing = await Account.create({
    name: 'WS Chequing', householdId, accountType: 'checking',
    entityId: personalId, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  chequingId = chequing.id;
  // Carryforwards rolled and a T5 present, so a clean year is genuinely clean.
  await Carryforward.create({
    entityId: personalId, kind: 'rrsp_room', asOfYear: 2026, amount: '10000', notes: null,
  } as never);
  await TaxSlip.create({
    entityId: personalId, year: 2026, slipType: 'T5', issuer: 'CDG', boxValues: { box11: 76500 },
  } as never);
});

let fp = 0;
async function txn(over: Record<string, unknown> = {}) {
  fp += 1;
  return Transaction.create({
    accountId: chequingId, householdId, entityId: personalId,
    date: '2026-09-20', amount: '-100', currency: 'CAD',
    merchantRaw: 'M', merchantClean: 'M',
    importBatch: 'b', sourceRowFingerprint: `fp${fp}`, sourceIdentityFingerprint: `sif${fp}`,
    ...over,
  } as never);
}

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

const build = (f: TaxYearFacts = facts()) => buildCompletenessReport({
  entityId: personalId, year: 2026, facts: f, rates: ratesFor(2026), now: NOW,
});

test('a clean year is complete, and says so with a coverage date', () => {
  // The "nobody checked looks like no problems" failure. An affirmative report must
  // be distinguishable from an unattempted one.
  return (async () => {
    await txn({ date: '2026-09-20', amount: '-50' });
    const report = await build();
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.gaps, []);
    assert.equal(report.coverageThrough, '2026-09-20');
    assert.ok(report.checkedAt.startsWith('2026-09-29'));
  })();
});

test('an empty year reports no coverage rather than a false clean bill', async () => {
  const report = await build();
  assert.equal(report.coverageThrough, null);
});

test('an unclassified corp draw blocks, priced against the current return', async () => {
  const corpLeg = await Transaction.create({
    accountId: chequingId, householdId, entityId: corpId,
    date: '2026-04-01', amount: '-15000', currency: 'CAD',
    merchantRaw: 'X', merchantClean: 'X',
    importBatch: 'b', sourceRowFingerprint: 'c1', sourceIdentityFingerprint: 'sc1',
    txnType: 'transfer',
  } as never);
  await txn({ date: '2026-04-01', amount: '15000', txnType: 'transfer', linkedTransactionId: corpLeg.id });

  const report = await build(facts({
    nonEligibleDividends: [{ source: 'CDG', amount: D('67000'), cadAmount: D('67000') }],
  }));
  assert.equal(report.status, 'blocked');
  const draws = report.blockers.find((b) => b.kind === 'unclassified_corp_draws');
  assert.ok(draws, `expected the draws blocker, got ${report.blockers.map((b) => b.kind).join(', ')}`);
  assert.equal(draws.amount, '15000.00');
  assert.equal(draws.taxEstimate, '3041.80');
});

test('a draw classified only by an inherited category is NOT reported missing', async () => {
  // The four-route resolution. The classification queue would still call this row
  // pending (its test is `taxTreatmentOverride IS NULL`), but buildPersonalFacts
  // counts its income — so reporting it as missing money would be a false blocker.
  const parent = await Category.create({
    householdId, name: 'Corp draws', taxTreatment: 'non_eligible_dividend', parentId: null,
  } as never);
  const child = await Category.create({
    householdId, name: 'Dividends', taxTreatment: 'none', parentId: parent.id,
  } as never);
  const corpLeg = await Transaction.create({
    accountId: chequingId, householdId, entityId: corpId,
    date: '2026-04-01', amount: '-15000', currency: 'CAD',
    merchantRaw: 'X', merchantClean: 'X',
    importBatch: 'b', sourceRowFingerprint: 'c1', sourceIdentityFingerprint: 'sc1',
    txnType: 'transfer',
  } as never);
  await txn({
    date: '2026-04-01', amount: '15000', txnType: 'transfer',
    linkedTransactionId: corpLeg.id, finalCategoryId: child.id,
  });

  const report = await build();
  assert.ok(
    !report.blockers.some((b) => b.kind === 'unclassified_corp_draws'),
    'an inherited treatment counts as classified',
  );
});

test('a corp outbound transfer with no counterpart blocks, with no tax estimate', async () => {
  const corpAccount = await Account.create({
    name: 'Corp Chequing', householdId, accountType: 'checking',
    entityId: corpId, taxStatus: 'n_a', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: corpAccount.id, householdId, entityId: corpId,
    date: '2026-05-01', amount: '-9000', currency: 'CAD',
    merchantRaw: 'TRANSFER', merchantClean: 'TRANSFER',
    importBatch: 'b', sourceRowFingerprint: 'c2', sourceIdentityFingerprint: 'sc2',
    txnType: 'transfer',
  } as never);

  const report = await build();
  const item = report.blockers.find((b) => b.kind === 'unimported_outbound_corp_transfer');
  assert.ok(item, `expected the corp blocker, got ${report.blockers.map((b) => b.kind).join(', ')}`);
  assert.equal(item.amount, '9000.00');
  assert.equal(item.taxEstimate, null);
});

test('a corp expense to a third party is not reported as an unimported leg', async () => {
  // The rejected predicate would flag every one of these.
  const corpAccount = await Account.create({
    name: 'Corp Chequing', householdId, accountType: 'checking',
    entityId: corpId, taxStatus: 'n_a', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: corpAccount.id, householdId, entityId: corpId,
    date: '2026-05-01', amount: '-6.00', currency: 'CAD',
    merchantRaw: 'RBC MONTHLY FEE', merchantClean: 'RBC MONTHLY FEE',
    importBatch: 'b', sourceRowFingerprint: 'c3', sourceIdentityFingerprint: 'sc3',
    txnType: 'purchase',
  } as never);

  const report = await build();
  assert.ok(!report.blockers.some((b) => b.kind === 'unimported_outbound_corp_transfer'));
});

test('the report is recomputed when import coverage changes but facts do not', async () => {
  // The staleness regression. Completeness is not derived from facts, so it must never
  // be keyed on them — importing a statement changes the report and no fact.
  await txn({ date: '2026-09-20', amount: '-50' });
  const f = facts();
  const before = await build(f);
  assert.equal(before.status, 'complete');

  const corpAccount = await Account.create({
    name: 'Corp Chequing', householdId, accountType: 'checking',
    entityId: corpId, taxStatus: 'n_a', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: corpAccount.id, householdId, entityId: corpId,
    date: '2026-05-01', amount: '-9000', currency: 'CAD',
    merchantRaw: 'TRANSFER', merchantClean: 'TRANSFER',
    importBatch: 'b', sourceRowFingerprint: 'c4', sourceIdentityFingerprint: 'sc4',
    txnType: 'transfer',
  } as never);

  const after = await build(f);
  assert.equal(after.status, 'blocked', 'the same facts must produce a different report');
});

test('a T4A slip the engine never reads is reported as reconciling against nothing', async () => {
  await TaxSlip.create({
    entityId: personalId, year: 2026, slipType: 'T4A', issuer: 'Somebody',
    boxValues: { box048: 2500 },
  } as never);
  const report = await build();
  const item = report.gaps.find((g) => g.kind === 'unreconciled_slips');
  assert.ok(item, report.gaps.map((g) => g.kind).join(', '));
  assert.equal(item.amount, '2500.00');
});

test('worst-wins: a blocker and a gap together report blocked', async () => {
  await TaxSlip.create({
    entityId: personalId, year: 2026, slipType: 'T4A', issuer: 'S', boxValues: { box048: 10 },
  } as never);
  const corpAccount = await Account.create({
    name: 'Corp Chequing', householdId, accountType: 'checking',
    entityId: corpId, taxStatus: 'n_a', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: corpAccount.id, householdId, entityId: corpId,
    date: '2026-05-01', amount: '-9000', currency: 'CAD',
    merchantRaw: 'TRANSFER', merchantClean: 'TRANSFER',
    importBatch: 'b', sourceRowFingerprint: 'c5', sourceIdentityFingerprint: 'sc5',
    txnType: 'transfer',
  } as never);

  const report = await build();
  assert.equal(report.status, 'blocked');
  assert.ok(report.blockers.length > 0);
  assert.ok(report.gaps.length > 0);
});

test('carryforwards stopping before the year is a gap', async () => {
  await Carryforward.destroy({ where: { entityId: personalId } });
  await Carryforward.create({
    entityId: personalId, kind: 'rrsp_room', asOfYear: 2025, amount: '10000', notes: null,
  } as never);
  const report = await build();
  const item = report.gaps.find((g) => g.kind === 'carryforwards_not_rolled');
  assert.ok(item);
  assert.match(item.title, /2025/);
});

test('duplicate pairs in the period surface as a gap with the overstatement', async () => {
  const counterpart = await txn({ date: '2026-03-01', amount: '2000' });
  await txn({ date: '2026-03-01', amount: '-2000', linkedTransactionId: counterpart.id });
  await txn({ date: '2026-03-01', amount: '-2000', linkedTransactionId: counterpart.id });
  const report = await build();
  const item = report.gaps.find((g) => g.kind === 'duplicate_pairs');
  assert.ok(item, report.gaps.map((g) => g.kind).join(', '));
  assert.equal(item.amount, '-2000.00');
});

test('a USD draw is reported in CAD, not at its face value', async () => {
  // There is no cad_amount column: `buildPersonalFacts` converts per row through
  // toCad and so must this loader. 2026 holds 30 USD transfers in prod, and summing
  // those as CAD would both misstate the blocker's size and misprice its tax.
  //
  // An earlier version of this code read a `cadAmount` property off Transaction that
  // does not exist, so it silently fell back to the raw amount and every non-CAD row
  // was reported at face value.
  const { FxRate } = await import('../../models');
  await FxRate.create({
    fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: '2026-04-01',
    rate: '1.40', source: 'test', fetchedAt: new Date(),
  } as never);

  const corpLeg = await Transaction.create({
    accountId: chequingId, householdId, entityId: corpId,
    date: '2026-04-01', amount: '-10000', currency: 'USD',
    merchantRaw: 'X', merchantClean: 'X', txnType: 'transfer',
    importBatch: 'b', sourceRowFingerprint: 'u1', sourceIdentityFingerprint: 'su1',
  } as never);
  await txn({
    date: '2026-04-01', amount: '10000', currency: 'USD',
    txnType: 'transfer', linkedTransactionId: corpLeg.id,
  });

  const report = await build();
  const draws = report.blockers.find((b) => b.kind === 'unclassified_corp_draws');
  assert.ok(draws, report.blockers.map((b) => b.kind).join(', '));
  assert.equal(draws.amount, '14000.00', 'USD 10,000 at 1.40, not 10,000');
});
