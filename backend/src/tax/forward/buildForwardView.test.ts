/**
 * "2026 at the current run rate" — year-to-date actuals plus a projected remainder,
 * priced through the engine.
 *
 * Connor's question was "it needs to be accurate so I know what I'm getting myself
 * into". Every other part of this plan answers what happened. This answers what is
 * coming, which is the number he acts on when deciding December draws and when paying
 * in April.
 *
 * Derived, not persisted. An earlier design made this a fourth `ScenarioKind`, which
 * would need a new union value in three files, a third `resolveScenario` branch, a
 * cache exemption and a guard rejecting parentage — machinery whose entire purpose is
 * to stop a run-rate figure being cached, a problem that only exists once it is a
 * Scenario. Per the primitives rule, derived means a computation.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { Account, Entity, Household, Transaction } from '../../models';
import { D } from '../util/decimal';
import { ratesFor } from '../engine/brackets';
import { buildForwardView } from './buildForwardView';
import type { TaxYearFacts } from '../engine/types';

let householdId: number;
let personalId: number;
let corpId: number;
let personalAccountId: number;

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
  const account = await Account.create({
    name: 'WS Chequing', householdId, accountType: 'checking',
    entityId: personalId, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  personalAccountId = account.id;
});

let fp = 0;
/** A classified corp→personal draw: a personal leg linked to a corp leg. */
async function draw(date: string, amount: string) {
  fp += 2;
  const corpLeg = await Transaction.create({
    accountId: personalAccountId, householdId, entityId: corpId,
    date, amount: `-${amount}`, currency: 'CAD',
    merchantRaw: 'X', merchantClean: 'X', txnType: 'transfer',
    importBatch: 'b', sourceRowFingerprint: `c${fp}`, sourceIdentityFingerprint: `sc${fp}`,
  } as never);
  return Transaction.create({
    accountId: personalAccountId, householdId, entityId: personalId,
    date, amount, currency: 'CAD',
    merchantRaw: 'X', merchantClean: 'X', txnType: 'transfer',
    linkedTransactionId: corpLeg.id,
    taxTreatmentOverride: 'non_eligible_dividend',
    importBatch: 'b', sourceRowFingerprint: `p${fp}`, sourceIdentityFingerprint: `sp${fp}`,
  } as never);
}

/** A non-draw transaction, which makes its month COVERED without adding draws. */
async function spend(date: string) {
  fp += 1;
  return Transaction.create({
    accountId: personalAccountId, householdId, entityId: personalId,
    date, amount: '-40', currency: 'CAD',
    merchantRaw: 'GROCERY', merchantClean: 'GROCERY', txnType: 'purchase',
    importBatch: 'b', sourceRowFingerprint: `s${fp}`, sourceIdentityFingerprint: `ss${fp}`,
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

const build = (now: string, f: TaxYearFacts = facts()) => buildForwardView({
  entityId: personalId, year: 2026, facts: f, rates: ratesFor(2026), now: new Date(now),
});

test('six months of $10,000 draws projects $120,000 and prices it', async () => {
  for (const m of ['01', '02', '03', '04', '05', '06']) await draw(`2026-${m}-15`, '10000');
  const view = await build('2026-06-30T00:00:00Z', facts({
    nonEligibleDividends: [{ source: 'CDG', amount: D('60000'), cadAmount: D('60000') }],
  }));
  assert.equal(view.draws.actualToDate.toFixed(2), '60000.00');
  assert.equal(view.draws.projectedTotal.toFixed(2), '120000.00');
  // The remaining $60,000 priced on top of the $60,000 already on the return.
  assert.ok(D(view.projectedAdditionalTax).greaterThan(0), view.projectedAdditionalTax);
  // Within a cent of the two reported totals' difference, not exactly equal to it:
  // the service subtracts unrounded Decimals and rounds once, while re-deriving from
  // the two already-rounded strings can differ by a cent. The service's order is the
  // accurate one, so the test accommodates it rather than forcing the service to
  // round twice.
  const rederived = D(view.projectedTotalPayable).minus(D(view.currentTotalPayable));
  assert.ok(
    rederived.minus(D(view.projectedAdditionalTax)).abs().lessThanOrEqualTo(D('0.01')),
    `${rederived.toFixed(2)} vs ${view.projectedAdditionalTax}`,
  );
});

test('a month with transactions but no draws counts as a real zero', async () => {
  for (const m of ['01', '02', '03', '04', '05']) await draw(`2026-${m}-15`, '10000');
  await spend('2026-06-10');
  const view = await build('2026-06-30T00:00:00Z');
  assert.equal(view.draws.coveredMonths, 6);
  assert.equal(view.draws.projectedTotal.toFixed(2), '100000.00');
});

test('a month with nothing at all is reported as unimported, not as zero draws', async () => {
  for (const m of ['01', '02', '03', '04', '05']) await draw(`2026-${m}-15`, '10000');
  const view = await build('2026-06-30T00:00:00Z');
  assert.equal(view.draws.coveredMonths, 5);
  assert.deepEqual(view.draws.uncoveredMonths, [6]);
  assert.equal(view.draws.projectedTotal.toFixed(2), '120000.00');
});

test('only corp→personal draws count, not ordinary spending', async () => {
  await draw('2026-01-15', '10000');
  await spend('2026-01-20');
  await spend('2026-01-21');
  const view = await build('2026-01-31T00:00:00Z');
  assert.equal(view.draws.actualToDate.toFixed(2), '10000.00');
});

test('an unclassified transfer from the corp still counts as a draw', async () => {
  // The forward view asks how much money is leaving the corp, not how much has been
  // labelled. Counting only classified rows would project low for exactly the
  // taxpayer whose queue is behind — which is the situation this plan exists for.
  const corpLeg = await Transaction.create({
    accountId: personalAccountId, householdId, entityId: corpId,
    date: '2026-01-15', amount: '-10000', currency: 'CAD',
    merchantRaw: 'X', merchantClean: 'X', txnType: 'transfer',
    importBatch: 'b', sourceRowFingerprint: 'cu1', sourceIdentityFingerprint: 'scu1',
  } as never);
  await Transaction.create({
    accountId: personalAccountId, householdId, entityId: personalId,
    date: '2026-01-15', amount: '10000', currency: 'CAD',
    merchantRaw: 'X', merchantClean: 'X', txnType: 'transfer',
    linkedTransactionId: corpLeg.id,
    importBatch: 'b', sourceRowFingerprint: 'pu1', sourceIdentityFingerprint: 'spu1',
  } as never);
  const view = await build('2026-01-31T00:00:00Z');
  assert.equal(view.draws.actualToDate.toFixed(2), '10000.00');
});

test('a completed year projects nothing and matches the actual return', async () => {
  for (const m of ['01','02','03','04','05','06','07','08','09','10','11','12']) {
    await draw(`2026-${m}-15`, '10000');
  }
  const view = await build('2026-12-31T00:00:00Z', facts({
    nonEligibleDividends: [{ source: 'CDG', amount: D('120000'), cadAmount: D('120000') }],
  }));
  assert.equal(view.draws.projectedRemainder.toFixed(2), '0.00');
  assert.equal(view.projectedAdditionalTax, '0.00');
  assert.equal(view.projectedTotalPayable, view.currentTotalPayable);
});

test('it states that it is a projection and what it assumed', async () => {
  // Part 0's discipline. A forward number that reads like a filed number is the
  // failure that part exists to prevent.
  for (const m of ['01', '02', '03']) await draw(`2026-${m}-15`, '10000');
  const view = await build('2026-03-31T00:00:00Z');
  assert.equal(view.isProjection, true);
  assert.match(view.draws.basis, /Projected from 3 months/);
});

test('a year with no transactions projects nothing and says why', async () => {
  const view = await build('2026-06-30T00:00:00Z');
  assert.equal(view.draws.projectedTotal.toFixed(2), '0.00');
  assert.match(view.draws.basis, /no months/i);
});

test('asOfMonth comes from now, so the view advances with the calendar', async () => {
  // The reason this must not be cached on facts: the same rows produce a different
  // projection in July than in June, with nothing about the facts having changed.
  for (const m of ['01', '02', '03']) await draw(`2026-${m}-15`, '10000');
  const june = await build('2026-06-30T00:00:00Z');
  const march = await build('2026-03-31T00:00:00Z');
  assert.equal(march.draws.coveredMonths, 3);
  assert.equal(june.draws.coveredMonths, 3);
  assert.deepEqual(march.draws.uncoveredMonths, []);
  assert.deepEqual(june.draws.uncoveredMonths, [4, 5, 6], 'June sees three empty months');
});

test('a future year is not projected from an empty present', async () => {
  const view = await buildForwardView({
    entityId: personalId, year: 2027, facts: facts(), rates: ratesFor(2027),
    now: new Date('2026-06-30T00:00:00Z'),
  });
  assert.equal(view.draws.coveredMonths, 0);
  assert.equal(view.draws.uncoveredMonths.length, 0, 'none of 2027 has elapsed');
});
