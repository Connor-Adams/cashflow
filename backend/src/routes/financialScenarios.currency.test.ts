/**
 * Golden lock for the scenario planner's default-currency resolution.
 *
 * resolveHouseholdCurrency picks the currency with the largest absolute cash
 * balance, excluding `investment` and `credit_card` accounts (a THIRD distinct
 * exclusion set: the forecast route excludes only `investment`, safe-to-spend
 * also excludes `loan`). This test pins the resolved currency for a
 * multi-currency household so the dedup onto the shared
 * `resolveForecastCurrency` helper provably keeps the pick unchanged.
 *
 * The household is constructed so the EXCLUSION matters: the investment (EUR)
 * and credit_card (GBP) balances are LARGER than every cash balance, so if the
 * exclusion set ever broke they would win and this test would fail.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Account, Household, User } from '../models';
import { resolveHouseholdCurrency } from './financialScenarios';

let HH = 0;
let USER = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  const user = await User.create({
    email: 'scenario-ccy@example.com',
    displayName: 'ScenarioCcy',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  const household = await Household.create({ name: 'ScenarioCcy household' } as never);
  HH = household.id;
  USER = user.id;
});

function account(over: Record<string, unknown>) {
  return Account.create({
    householdId: HH,
    ownerUserId: USER,
    owner: 'connor',
    visibility: 'household',
    accountType: 'chequing',
    defaultCurrency: 'CAD',
    openingBalance: '0.0000',
    ...over,
  } as never);
}

test('resolveHouseholdCurrency: largest non-excluded cash balance wins (USD over CAD)', async () => {
  await account({ name: 'USD chequing', defaultCurrency: 'USD', openingBalance: '500.0000' });
  await account({ name: 'CAD chequing', defaultCurrency: 'CAD', openingBalance: '100.0000' });
  // Excluded — both larger than every cash balance; must NOT influence the pick.
  await account({ name: 'EUR brokerage', accountType: 'investment', defaultCurrency: 'EUR', openingBalance: '9999.0000' });
  await account({ name: 'GBP card', accountType: 'credit_card', defaultCurrency: 'GBP', openingBalance: '8888.0000' });

  const ccy = await resolveHouseholdCurrency(HH, '2026-06-15');
  assert.equal(ccy, 'USD');
});

test('resolveHouseholdCurrency: CAD breaks ties', async () => {
  await account({ name: 'USD chequing', defaultCurrency: 'USD', openingBalance: '200.0000' });
  await account({ name: 'CAD chequing', defaultCurrency: 'CAD', openingBalance: '200.0000' });

  const ccy = await resolveHouseholdCurrency(HH, '2026-06-15');
  assert.equal(ccy, 'CAD');
});

test('resolveHouseholdCurrency: no eligible cash → CAD fallback', async () => {
  await account({ name: 'EUR brokerage', accountType: 'investment', defaultCurrency: 'EUR', openingBalance: '9999.0000' });

  const ccy = await resolveHouseholdCurrency(HH, '2026-06-15');
  assert.equal(ccy, 'CAD');
});

test('resolveHouseholdCurrency: closed accounts on/before asOf are ignored', async () => {
  await account({ name: 'USD chequing', defaultCurrency: 'USD', openingBalance: '500.0000' });
  await account({
    name: 'Closed EUR chequing',
    defaultCurrency: 'EUR',
    openingBalance: '9999.0000',
    closedAt: '2026-01-01',
  });

  const ccy = await resolveHouseholdCurrency(HH, '2026-06-15');
  assert.equal(ccy, 'USD');
});
