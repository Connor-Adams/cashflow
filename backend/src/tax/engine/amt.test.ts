import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal.js';
import { ratesFor } from './brackets.js';
import { computeAmt } from './amt.js';

test('AMT kicks in when large cap gains push AMT above regular tax', () => {
  const r = ratesFor(2025);
  const result = computeAmt({
    taxableIncome: D('250000'),
    regularFederalTax: D('48000'),
    capitalGainsGross: D('500000'),
    capitalGainsTaxable: D('250000'),
    eligibleDividendsGrossed: D('0'),
    nonEligibleDividendsGrossed: D('0'),
    totalNonRefundableCredits: D('2400'),
    totalDtcCredits: D('0'),
    rates: r,
  });
  assert.ok(result.amtAdditional.greaterThan(0), 'AMT should produce additional tax');
  assert.ok(result.amtPayable.greaterThan(D('48000')), 'AMT payable should exceed regular tax');
});

test('AMT base uses actual dividends — gross-up excluded from adjusted taxable income', () => {
  const r = ratesFor(2024);
  // $200,000 actual eligible dividends → $276,000 grossed-up in taxable income.
  // Under AMT the gross-up is excluded: ATI = 276,000 − 76,000 = 200,000.
  // amtBase = 200,000 − 173,205 (2024 exemption) = 26,795.
  const result = computeAmt({
    taxableIncome: D('276000'),
    regularFederalTax: D('23217.72'),
    capitalGainsGross: D('0'),
    capitalGainsTaxable: D('0'),
    eligibleDividendsGrossed: D('276000'),
    nonEligibleDividendsGrossed: D('0'),
    totalNonRefundableCredits: D('2123.40'),
    totalDtcCredits: D('41454.65'),
    rates: r,
  });
  assert.equal(result.amtBase.toFixed(2), '26795.00');
  // amtPayable = 26,795 × 0.205 − (2,123.40 × 0.5 non-ref credits; DTC fully denied)
  //            = 5,492.975 − 1,061.70 = 4,431.275
  assert.equal(result.amtPayable.toFixed(2), '4431.28');
});

test('AMT excludes non-eligible dividend gross-up and denies the DTC', () => {
  const r = ratesFor(2024);
  // $100,000 actual non-eligible dividends → $115,000 grossed-up.
  // ATI = 115,000 − 15,000 = 100,000 < exemption → no AMT, even though the
  // grossed-up amount (115,000) would not change that here; the key assertion
  // is that the DTC is NOT allowed to reduce AMT payable.
  const withDtc = computeAmt({
    taxableIncome: D('400000'),
    regularFederalTax: D('0'),
    capitalGainsGross: D('0'),
    capitalGainsTaxable: D('0'),
    eligibleDividendsGrossed: D('0'),
    nonEligibleDividendsGrossed: D('115000'),
    totalNonRefundableCredits: D('0'),
    totalDtcCredits: D('10384.62'),
    rates: r,
  });
  const withoutDtc = computeAmt({
    taxableIncome: D('400000'),
    regularFederalTax: D('0'),
    capitalGainsGross: D('0'),
    capitalGainsTaxable: D('0'),
    eligibleDividendsGrossed: D('0'),
    nonEligibleDividendsGrossed: D('115000'),
    totalNonRefundableCredits: D('0'),
    totalDtcCredits: D('0'),
    rates: r,
  });
  // ATI = 400,000 − 15,000 gross-up = 385,000; base = 385,000 − 173,205 = 211,795
  assert.equal(withDtc.amtBase.toFixed(2), '211795.00');
  // DTC must not reduce AMT payable (dividend tax credit denied under AMT)
  assert.equal(withDtc.amtPayable.toFixed(2), withoutDtc.amtPayable.toFixed(2));
});

test('AMT does not apply when regular tax exceeds AMT', () => {
  const r = ratesFor(2025);
  const result = computeAmt({
    taxableIncome: D('80000'),
    regularFederalTax: D('12000'),
    capitalGainsGross: D('0'),
    capitalGainsTaxable: D('0'),
    eligibleDividendsGrossed: D('0'),
    nonEligibleDividendsGrossed: D('0'),
    totalNonRefundableCredits: D('2400'),
    totalDtcCredits: D('0'),
    rates: r,
  });
  assert.equal(result.amtAdditional.toFixed(2), '0.00');
});
