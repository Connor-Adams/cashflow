/**
 * The T4 is the record of what was actually deducted from pay. The engine used
 * to recompute CPP and EI from box 14 even when the slip said otherwise, which
 * is wrong for anyone the employer did not deduct for — Connor's employer is his
 * father's business, so he is EI-exempt and his T4 has no box 18.
 *
 * Also covered here: enhanced CPP is a deduction (L22215), not a credit; the
 * "box 14 differs" warning must compare like with like; and L43700 counts tax
 * withheld on every slip that carries it, not just the T4.
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
    year: 2026,
    jurisdiction: 'CA-ON',
    employmentIncome: [],
    selfEmploymentIncome: [],
    selfEmploymentExpenses: [],
    interestIncome: [],
    eligibleDividends: [],
    nonEligibleDividends: [],
    capitalGainEvents: [],
    rrspContribs: [],
    fhsaContribs: [],
    donations: [],
    rentalIncome: [],
    rentalExpenses: [],
    medicalExpenses: [],
    slips: [],
    carryforwards: {
      netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'),
      instalmentsPaid: D('0'), fhsaLifetimeContributions: D('0'), fhsaRoom: D('0'),
    },
    ageAtYearEnd: 40,
    ...over,
  } as TaxYearFacts;
}

let slipSeq = 0;
function slip(slipType: SlipFact['slipType'], boxes: Record<string, string>): SlipFact {
  slipSeq += 1;
  return {
    slipId: slipSeq,
    slipType,
    issuer: 'Test',
    boxes: Object.fromEntries(Object.entries(boxes).map(([k, v]) => [k, D(v)])),
  };
}

const line = (ret: ReturnType<typeof buildT1>, code: string) =>
  ret.lines.find((l) => l.code === code)?.amount.toFixed(2);

test('a T4 with no box 18 means no EI premium — EI is not recomputed from box 14', () => {
  const ret = buildT1(facts({
    slips: [slip('T4', { box14: '60000', box16: '3361.25', box22: '9000' })],
  }), RATES);
  assert.equal(ret.totals.eiPremium.toFixed(2), '0.00');
});

test('CPP and EI are read from T4 boxes 16, 16A and 18', () => {
  const ret = buildT1(facts({
    slips: [slip('T4', { box14: '90000', box16: '4230.45', box16A: '416.00', box18: '1123.07', box22: '18000' })],
  }), RATES);
  assert.equal(ret.totals.cppContrib.toFixed(2), '4646.45');
  assert.equal(ret.totals.eiPremium.toFixed(2), '1123.07');
});

test('enhanced CPP (the first-additional share of box 16, plus box 16A) is deducted on L22215', () => {
  // Box 16 at 5.95% is 4.95% base + 1% first additional. Box 16A (CPP2) is all
  // enhanced. 4230.45 × 1/5.95 = 711.00; + 416.00 = 1127.00.
  const ret = buildT1(facts({
    slips: [slip('T4', { box14: '90000', box16: '4230.45', box16A: '416.00', box18: '1123.07', box22: '18000' })],
  }), RATES);
  assert.equal(line(ret, 'L22215'), '1127.00');
  assert.equal(ret.totals.netIncome.toFixed(2), '88873.00', 'L22215 reduces net income');
  // The credit carries base CPP only: 4230.45 − 711.00 = 3519.45, plus EI.
  const l42000 = ret.lines.find((l) => l.code === 'L42000');
  const cppEi = l42000?.inputs.find((i) => i.source === 'CPP+EI × low rate');
  assert.equal(cppEi?.amount.toFixed(2), D('3519.45').plus('1123.07').times(RATES.donationLowRate).toFixed(2));
});

test('with no T4, CPP and EI are computed and the enhanced share is still deducted', () => {
  const ret = buildT1(facts({
    employmentIncome: [{ source: 'pay', amount: D('60000'), cadAmount: D('60000') }],
  }), RATES);
  // (60000 − 3500) × 5.95% = 3361.75; enhanced share 1% × 56500 = 565.00.
  assert.equal(ret.totals.cppContrib.toFixed(2), '3361.75');
  assert.ok(ret.totals.eiPremium.greaterThan(0), 'EI computed when no slip says otherwise');
  assert.equal(line(ret, 'L22215'), '565.00');
});

test('the box 14 warning compares net pay deposits, not gross', () => {
  // Deposits are box 14 less what was withheld from pay.
  const net = D('60000').minus('3361.25').minus('9000');
  const ret = buildT1(facts({
    employmentIncome: [{ source: 'pay', amount: net, cadAmount: net }],
    slips: [slip('T4', { box14: '60000', box16: '3361.25', box22: '9000' })],
  }), RATES);
  assert.ok(
    !ret.warnings.some((w) => w.includes('T4')),
    `no reconciliation warning for matching net pay, got ${JSON.stringify(ret.warnings)}`,
  );
});

test('the box 14 warning still fires when deposits really disagree with the T4', () => {
  const ret = buildT1(facts({
    employmentIncome: [{ source: 'pay', amount: D('20000'), cadAmount: D('20000') }],
    slips: [slip('T4', { box14: '60000', box16: '3361.25', box22: '9000' })],
  }), RATES);
  assert.ok(ret.warnings.some((w) => w.includes('T4')), 'mismatch is reported');
});

test('L43700 includes tax withheld on a T4A (box 022) as well as the T4', () => {
  const ret = buildT1(facts({
    slips: [
      slip('T4', { box14: '60000', box16: '3361.25', box22: '9000' }),
      slip('T4A', { box020: '10000', box022: '1500' }),
    ],
  }), RATES);
  assert.equal(line(ret, 'L43700'), '10500.00');
});

test('a T4A box is read once even when stored under both key spellings', () => {
  const ret = buildT1(facts({
    slips: [slip('T4A', { box022: '1500', box22: '1500' })],
  }), RATES);
  assert.equal(line(ret, 'L43700'), '1500.00');
});
