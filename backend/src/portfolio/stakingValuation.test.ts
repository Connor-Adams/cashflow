import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueStakingReward } from './stakingValuation';

test('CAD-priced reward: amount = qty * close, no FX', () => {
  const r = valueStakingReward({ quantity: 2, closePrice: 3, priceCurrency: 'CAD', usdCadRate: null });
  assert.deepEqual(r, { amountCad: 6, pricePerUnitCad: 3 });
});

test('USD-priced reward: applies USD->CAD rate', () => {
  const r = valueStakingReward({ quantity: 2, closePrice: 3, priceCurrency: 'USD', usdCadRate: 1.4 });
  assert.deepEqual(r, { amountCad: 8.4, pricePerUnitCad: 4.2 });
});

test('USD-priced reward without rate is an error', () => {
  const r = valueStakingReward({ quantity: 2, closePrice: 3, priceCurrency: 'USD', usdCadRate: null });
  assert.ok('error' in r);
});

test('rounds amount to 4dp and price to 8dp', () => {
  const r = valueStakingReward({ quantity: 0.0000544651, closePrice: 3500, priceCurrency: 'CAD', usdCadRate: null });
  assert.deepEqual(r, { amountCad: 0.1906, pricePerUnitCad: 3500 });
});
