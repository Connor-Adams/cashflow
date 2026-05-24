import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor } from '../../src/tax/engine/brackets';
import {
  basicPersonalAmountFederalApplied,
  spousalCreditFederal,
  ageCreditFederal,
  donationCreditFederal,
  basicPersonalAmountOntarioApplied,
  spousalCreditOntario,
  ageCreditOntario,
  donationCreditOntario,
  employmentAmountFederalApplied,
  cppEiCreditAmount,
  medicalCreditFederal,
} from '../../src/tax/engine/credits';

// ─── Federal BPA ───────────────────────────────────────────────────────────────

test('BPA federal full amount at low income', () => {
  const r = ratesFor(2024);
  const c = basicPersonalAmountFederalApplied(D('50000'), r);
  assert.equal(c.toFixed(2), r.basicPersonalAmountFederal.toFixed(2));
});

test('BPA federal phased down at $200k taxable income', () => {
  const r = ratesFor(2024);
  const c = basicPersonalAmountFederalApplied(D('200000'), r);
  assert.ok(c.lessThan(r.basicPersonalAmountFederal));
  assert.ok(c.greaterThan(r.bpaFederalMin));
});

test('BPA federal at top bracket = bpaFederalMin', () => {
  const r = ratesFor(2024);
  const c = basicPersonalAmountFederalApplied(D('300000'), r);
  assert.equal(c.toFixed(2), r.bpaFederalMin.toFixed(2));
});

// ─── Federal Spousal ───────────────────────────────────────────────────────────

test('spousal credit reduced by spouse net income', () => {
  const r = ratesFor(2024);
  const full = spousalCreditFederal(D('0'), r);
  const reduced = spousalCreditFederal(D('5000'), r);
  assert.ok(reduced.lessThan(full));
  assert.equal(reduced.toFixed(2), full.minus(D('5000')).toFixed(2));
});

// ─── Federal Age ───────────────────────────────────────────────────────────────

test('age credit at 70 with low income = full ageAmountFederal', () => {
  const r = ratesFor(2024);
  const c = ageCreditFederal(70, D('30000'), r);
  assert.equal(c.toFixed(2), r.ageAmountFederal.toFixed(2));
});

test('age credit below 65 = 0', () => {
  const r = ratesFor(2024);
  assert.equal(ageCreditFederal(64, D('30000'), r).toFixed(2), '0.00');
});

// ─── Federal Donations ─────────────────────────────────────────────────────────

test('donation $100 federal: 15% × $100 = $15', () => {
  const r = ratesFor(2024);
  assert.equal(donationCreditFederal(D('100'), D('100000'), r).toFixed(2), '15.00');
});

test('donation $500 federal: 15% × $200 + 29% × $300 = $30 + $87 = $117', () => {
  const r = ratesFor(2024);
  assert.equal(donationCreditFederal(D('500'), D('100000'), r).toFixed(2), '117.00');
});

test('donation $500 at top bracket: 15% × $200 + 33% × $300 = $30 + $99 = $129', () => {
  const r = ratesFor(2024);
  assert.equal(donationCreditFederal(D('500'), D('300000'), r).toFixed(2), '129.00');
});

// ─── Ontario BPA ───────────────────────────────────────────────────────────────

test('BPA ontario is constant (no phaseout)', () => {
  const r = ratesFor(2024);
  const low = basicPersonalAmountOntarioApplied(D('30000'), r);
  const high = basicPersonalAmountOntarioApplied(D('300000'), r);
  assert.equal(low.toFixed(2), r.basicPersonalAmountOntario.toFixed(2));
  assert.equal(high.toFixed(2), r.basicPersonalAmountOntario.toFixed(2));
});

// ─── Ontario Spousal ──────────────────────────────────────────────────────────

test('spousal credit ontario full when spouse $0 income', () => {
  const r = ratesFor(2024);
  const c = spousalCreditOntario(D('0'), r);
  assert.equal(c.toFixed(2), r.spousalAmountOntario.toFixed(2));
});

test('spousal credit ontario reduced by spouse net income', () => {
  const r = ratesFor(2024);
  const reduced = spousalCreditOntario(D('3000'), r);
  const expected = r.spousalAmountOntario.minus(D('3000'));
  assert.equal(reduced.toFixed(2), expected.toFixed(2));
});

// ─── Ontario Age ──────────────────────────────────────────────────────────────

test('age credit ontario at 70 with low income = full ageAmountOntario', () => {
  const r = ratesFor(2024);
  const c = ageCreditOntario(70, D('30000'), r);
  assert.equal(c.toFixed(2), r.ageAmountOntario.toFixed(2));
});

test('age credit ontario below 65 = 0', () => {
  const r = ratesFor(2024);
  assert.equal(ageCreditOntario(64, D('30000'), r).toFixed(2), '0.00');
});

// ─── Ontario Donations ────────────────────────────────────────────────────────

test('donation $100 ontario: 5.05% × $100 = $5.05', () => {
  const r = ratesFor(2024);
  const expected = D('100').times(r.donationLowRateOntario);
  assert.equal(donationCreditOntario(D('100'), D('100000'), r).toFixed(4), expected.toFixed(4));
});

test('donation $500 ontario: 5.05% × $200 + 11.16% × $300', () => {
  const r = ratesFor(2024);
  const expected = D('200').times(r.donationLowRateOntario).plus(D('300').times(r.donationHighRateOntario));
  assert.equal(donationCreditOntario(D('500'), D('100000'), r).toFixed(4), expected.toFixed(4));
});

// ─── Employment Amount ────────────────────────────────────────────────────────

test('employment amount caps at the rate table constant', () => {
  const r = ratesFor(2024);
  assert.equal(
    employmentAmountFederalApplied(D('5000'), r).toFixed(2),
    r.employmentAmountFederal.toFixed(2),
  );
});

test('employment amount at low income returns employment income', () => {
  const r = ratesFor(2024);
  assert.equal(employmentAmountFederalApplied(D('500'), r).toFixed(2), '500.00');
});

// ─── CPP/EI credit amount ─────────────────────────────────────────────────────

test('cppEiCreditAmount sums cpp + ei contributions', () => {
  assert.equal(cppEiCreditAmount(D('1000'), D('400')).toFixed(2), '1400.00');
});

// ─── Medical credit ───────────────────────────────────────────────────────────

test('medical credit: $5000 expenses, $30k income, threshold = min(30000*0.03=900, cap)', () => {
  const r = ratesFor(2024);
  const expected = D('5000').minus('900').times('0.15');
  assert.equal(medicalCreditFederal(D('5000'), D('30000'), r).toFixed(2), expected.toFixed(2));
});

test('medical credit: threshold capped at medicalThresholdCap when income is very high', () => {
  const r = ratesFor(2024);
  // 3% × $200k = $6000 but cap is $2759, so threshold = $2759
  const expected = D('5000').minus(r.medicalThresholdCap).times(r.donationLowRate);
  assert.equal(medicalCreditFederal(D('5000'), D('200000'), r).toFixed(2), expected.toFixed(2));
});

test('medical credit: expenses below threshold = $0', () => {
  const r = ratesFor(2024);
  // 3% × $30k = $900; expenses $500 < $900 → $0 credit
  assert.equal(medicalCreditFederal(D('500'), D('30000'), r).toFixed(2), '0.00');
});
