/**
 * L47600 exists as its own line, and net tax owing is computed before instalments.
 *
 * The CRA instalment test is defined on net tax owing BEFORE instalments are
 * credited — otherwise paying instalments would itself remove the obligation to pay
 * them. `t1.ts` folded instalments straight into L48200 alongside tax deducted at
 * source, and `grep -rn "47600" backend/src` returned nothing, so there was no line
 * the instalment computation could read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { ratesFor } from './brackets';
import { buildT1 } from './t1';
import type { SlipFact, TaxYearFacts } from './types';

const RATES = ratesFor(2026);

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

const t4 = (box14: string, box22: string): SlipFact => ({
  slipId: 1, slipType: 'T4', issuer: 'Employer',
  boxes: { box14: D(box14), box22: D(box22) },
});

const line = (ret: ReturnType<typeof buildT1>, code: string) =>
  ret.lines.find((l) => l.code === code)?.amount.toFixed(2);

test('L47600 reports instalments paid on its own line', () => {
  const ret = buildT1(facts({
    nonEligibleDividends: [{ source: 'CDG', amount: D('80000'), cadAmount: D('80000') }],
    carryforwards: { ...facts().carryforwards, instalmentsPaid: D('4000') },
  }), RATES);
  assert.equal(line(ret, 'L47600'), '4000.00');
});

test('L48200 still totals tax deducted plus instalments', () => {
  const ret = buildT1(facts({
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
    slips: [t4('80000', '9000')],
    carryforwards: { ...facts().carryforwards, instalmentsPaid: D('4000') },
  }), RATES);
  assert.equal(line(ret, 'L43700'), '9000.00');
  assert.equal(line(ret, 'L47600'), '4000.00');
  assert.equal(line(ret, 'L48200'), '13000.00');
});

test('netTaxOwing excludes instalments; refundOrOwing includes them', () => {
  // This is the whole reason the line was split. The CRA instalment test reads net
  // tax owing BEFORE instalments — crediting them first would let paying instalments
  // remove the obligation to pay them.
  const ret = buildT1(facts({
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
    slips: [t4('80000', '9000')],
    carryforwards: { ...facts().carryforwards, instalmentsPaid: D('4000') },
  }), RATES);
  const payable = ret.totals.totalPayable;
  assert.equal(ret.totals.netTaxOwing.toFixed(2), payable.minus(D('9000')).toFixed(2));
  assert.equal(ret.totals.refundOrOwing.toFixed(2), payable.minus(D('13000')).toFixed(2));
});

test('with no instalments paid, net tax owing and the balance agree', () => {
  const ret = buildT1(facts({
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
    slips: [t4('80000', '9000')],
  }), RATES);
  assert.equal(ret.totals.netTaxOwing.toFixed(2), ret.totals.refundOrOwing.toFixed(2));
  assert.equal(line(ret, 'L47600'), '0.00');
});

test('net tax owing is negative when withholding exceeds the tax', () => {
  // Connor's 2025: totalPayable 3,727.81 against 3,775.16 withheld — a $47.35 refund,
  // and the reason 2026 instalments were not required. A floor at zero here would
  // have made 2025 look like a $0 owing year, which happens to give the same answer,
  // but on a rising year the sign is what the two-year test reads.
  const ret = buildT1(facts({
    employmentIncome: [{ source: 'T4', amount: D('30000'), cadAmount: D('30000') }],
    slips: [t4('30000', '9000')],
  }), RATES);
  assert.ok(ret.totals.netTaxOwing.lessThan(0), ret.totals.netTaxOwing.toFixed(2));
});
