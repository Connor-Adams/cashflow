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
