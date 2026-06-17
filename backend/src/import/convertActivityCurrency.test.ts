import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertIncomeActivityToAccountCurrency } from './convertActivityCurrency';

const fx = (rate: number) => async () => ({ rate });
const base = { tradeDate: '2024-10-14', fees: null as number | null };

test('USD staking_reward in CAD account is converted to CAD', async () => {
  const r = await convertIncomeActivityToAccountCurrency(
    { ...base, activityType: 'staking_reward', currency: 'USD', amount: 0.0308, price: 2539.41853854, fees: 0.001 },
    'CAD',
    fx(1.3761),
  );
  assert.equal(r.currency, 'CAD');
  assert.equal(r.converted, true);
  assert.equal(r.amount, 0.0424); // 0.0308 * 1.3761 = 0.04238 -> 0.0424
  assert.equal(r.price, 3494.49385088); // 2539.41853854 * 1.3761
  assert.equal(r.fees, 0.0014); // 0.001 * 1.3761 = 0.0013761 -> 0.0014
});

test('CAD staking_reward is left unchanged (already account currency)', async () => {
  const r = await convertIncomeActivityToAccountCurrency(
    { ...base, activityType: 'staking_reward', currency: 'CAD', amount: 5, price: 2, fees: null },
    'CAD',
    fx(1.3761),
  );
  assert.deepEqual(r, { amount: 5, price: 2, fees: null, currency: 'CAD', converted: false });
});

test('USD buy is NOT converted (native-currency security purchase)', async () => {
  const r = await convertIncomeActivityToAccountCurrency(
    { ...base, activityType: 'buy', currency: 'USD', amount: -100, price: 50, fees: null },
    'CAD',
    fx(1.3761),
  );
  assert.deepEqual(r, { amount: -100, price: 50, fees: null, currency: 'USD', converted: false });
});

test('fx miss leaves the activity unchanged (safe degrade)', async () => {
  const r = await convertIncomeActivityToAccountCurrency(
    { ...base, activityType: 'staking_reward', currency: 'USD', amount: 0.03, price: 2500, fees: null },
    'CAD',
    async () => null,
  );
  assert.deepEqual(r, { amount: 0.03, price: 2500, fees: null, currency: 'USD', converted: false });
});

test('null amount/price/fees are preserved through conversion', async () => {
  const r = await convertIncomeActivityToAccountCurrency(
    { ...base, activityType: 'staking_reward', currency: 'USD', amount: null, price: null, fees: null },
    'CAD',
    fx(1.4),
  );
  assert.deepEqual(r, { amount: null, price: null, fees: null, currency: 'CAD', converted: true });
});
