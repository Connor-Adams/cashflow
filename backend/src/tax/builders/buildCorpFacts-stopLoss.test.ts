import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { Account, Entity, Household, InvestmentActivity, Security } from '../../models';
import { sumD } from '../util/decimal';
import { buildCorpFacts } from './buildCorpFacts';
import { buildT2 } from '../engine/t2';
import { ratesFor } from '../engine/brackets';
import { capitalGainOf } from '../engine/capital-gains';
import type { CapGainEvent } from '../engine/types';

// ITA s.40(3.3)/(3.4) — the corporate stop-loss rule. See corpStopLoss.ts.

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

const FY2025 = { startDate: '2025-01-01', endDate: '2025-12-31' };
const FY2026 = { startDate: '2026-01-01', endDate: '2026-12-31' };

async function seedCorp() {
  const household = await Household.create({ name: 'Stop-loss HH' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'Stop Loss Inc.', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Corp Invest', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  const sec = await Security.create({ symbol: 'STOP', name: 'Stop Corp', currency: 'CAD', householdId: household.id } as never);
  let n = 0;
  const trade = (activityType: 'buy' | 'sell', tradeDate: string, quantity: number, amount: number) =>
    InvestmentActivity.create({
      accountId: account.id, securityId: sec.id, activityType, tradeDate,
      quantity: String(quantity), amount: String(amount), currency: 'CAD', fees: null,
      description: activityType, sourceRowFingerprint: `fp-stop-${(n += 1)}`, importBatch: 'seed-stop',
    } as never);
  return { entity, sec, trade };
}

const netGains = (events: CapGainEvent[]) => sumD(events.map(capitalGainOf));

test('a corp loss with identical property bought back within 30 days is suspended, not allowed', async () => {
  const { entity, sec, trade } = await seedCorp();
  await trade('buy', '2025-01-10', 100, 2000);
  await trade('sell', '2025-03-01', 100, 1500); // loss 500
  await trade('buy', '2025-03-15', 100, 1600);  // repurchase inside the window, still held

  const facts = await buildCorpFacts(entity.id, FY2025);

  assert.equal(facts.capitalGainEvents.length, 1);
  const ev = facts.capitalGainEvents[0];
  assert.equal(ev.proceeds.minus(ev.acb).toFixed(2), '-500.00', 'raw loss is still visible');
  assert.equal(ev.stopLossSuspended?.toFixed(2), '500.00');
  assert.equal(ev.superficialLossDenied, undefined, 'corps are under s.40(3.4), not the superficial-loss rule');
  assert.equal(netGains(facts.capitalGainEvents).toFixed(2), '0.00');

  assert.equal(facts.suspendedCapitalLosses?.length, 1);
  assert.deepEqual(
    { ...facts.suspendedCapitalLosses![0], amount: facts.suspendedCapitalLosses![0].amount.toFixed(2) },
    { securityId: sec.id, dispositionDate: '2025-03-01', amount: '500.00', releasedOn: null },
  );

  const t2 = buildT2(facts, ratesFor(2025));
  assert.ok(
    t2.warnings.some((w) => w.includes('s.40(3.4)(a)') && w.includes('$500.00') && w.includes('still suspended')),
    JSON.stringify(t2.warnings),
  );
  assert.ok(t2.warnings.some((w) => w.includes('affiliated person')), 'affiliated-person limitation is stated');
  // The suspended loss must not reduce the corp's capital-gains pool.
  assert.equal(t2.totals.cdaEnding.toFixed(2), '0.00');
});

test('the suspended loss is recognized when the corp disposes of all identical property and does not reacquire within 30 days', async () => {
  const { entity, sec, trade } = await seedCorp();
  await trade('buy', '2025-01-10', 100, 2000);
  await trade('sell', '2025-03-01', 100, 1500); // loss 500, suspended
  await trade('buy', '2025-03-15', 100, 1600);
  await trade('sell', '2025-06-01', 100, 1700); // gain 100 on the substituted shares; position closed

  const facts = await buildCorpFacts(entity.id, FY2025);

  // The substituted shares' ACB is NOT bumped (no s.53(1)(f) for a stop-loss):
  // their sale is a plain 100 gain against the 1600 they cost.
  const closing = facts.capitalGainEvents.find((e) => e.date === '2025-06-01' && !e.stopLossReleasedFrom);
  assert.equal(closing?.acb.toFixed(2), '1600.00');

  const released = facts.capitalGainEvents.find((e) => e.stopLossReleasedFrom);
  assert.ok(released, 'a recognition event is emitted');
  assert.equal(released.stopLossReleasedFrom, '2025-03-01');
  assert.equal(released.date, '2025-06-01');
  assert.equal(released.securityId, sec.id);
  assert.equal(released.proceeds.minus(released.acb).toFixed(2), '-500.00');

  // −500 suspended (net 0) + 100 gain − 500 recognized = −400.
  assert.equal(netGains(facts.capitalGainEvents).toFixed(2), '-400.00');
  assert.equal(facts.suspendedCapitalLosses?.[0].releasedOn, '2025-06-01');
  assert.ok(
    (facts.factWarnings ?? []).some((w) => w.includes('s.40(3.4)(b)') && w.includes('recognized this year')),
    JSON.stringify(facts.factWarnings),
  );
});

test('a corp loss with no repurchase in the window is allowed in full', async () => {
  const { entity, trade } = await seedCorp();
  await trade('buy', '2025-01-10', 100, 2000);
  await trade('sell', '2025-03-01', 100, 1500);

  const facts = await buildCorpFacts(entity.id, FY2025);

  assert.equal(facts.capitalGainEvents.length, 1);
  assert.equal(facts.capitalGainEvents[0].stopLossSuspended, undefined);
  assert.equal(netGains(facts.capitalGainEvents).toFixed(2), '-500.00');
  assert.equal(facts.suspendedCapitalLosses, undefined);
  // Still tested, so the affiliated-person caveat applies.
  assert.ok((facts.factWarnings ?? []).some((w) => w.includes('s.251.1')));
});

test('a December loss is suspended by a January repurchase after fiscal year end, and recognized in the later year', async () => {
  const { entity, trade } = await seedCorp();
  await trade('buy', '2025-06-01', 100, 2000);
  await trade('sell', '2025-12-20', 100, 1500); // loss 500
  await trade('buy', '2026-01-10', 100, 1550);  // 21 days later, next fiscal year

  const fy25 = await buildCorpFacts(entity.id, FY2025);
  assert.equal(fy25.capitalGainEvents[0].stopLossSuspended?.toFixed(2), '500.00');
  assert.equal(netGains(fy25.capitalGainEvents).toFixed(2), '0.00');
  assert.equal(fy25.suspendedCapitalLosses?.[0].releasedOn, null);

  // Still held through FY2026: still suspended, reported, and not on the return.
  const held = await buildCorpFacts(entity.id, FY2026);
  assert.equal(held.capitalGainEvents.length, 0);
  assert.equal(held.suspendedCapitalLosses?.length, 1);
  assert.equal(held.suspendedCapitalLosses?.[0].dispositionDate, '2025-12-20');
  assert.equal(held.suspendedCapitalLosses?.[0].releasedOn, null);

  // Sold out in May 2026 with no buy-back: recognized in FY2026, not FY2025.
  await trade('sell', '2026-05-01', 100, 1550);
  const fy26 = await buildCorpFacts(entity.id, FY2026);
  const released = fy26.capitalGainEvents.find((e) => e.stopLossReleasedFrom === '2025-12-20');
  assert.equal(released?.date, '2026-05-01');
  assert.equal(netGains(fy26.capitalGainEvents).toFixed(2), '-500.00');
  const fy25Again = await buildCorpFacts(entity.id, FY2025);
  assert.equal(fy25Again.capitalGainEvents.some((e) => e.stopLossReleasedFrom), false);
});

test('buying identical property back within 30 days of selling out keeps the loss suspended', async () => {
  const { entity, trade } = await seedCorp();
  await trade('buy', '2025-01-10', 100, 2000);
  await trade('sell', '2025-03-01', 100, 1500); // loss 500, suspended
  await trade('buy', '2025-03-15', 100, 1600);
  await trade('sell', '2025-06-01', 100, 1700); // position closed ...
  await trade('buy', '2025-06-20', 100, 1700);  // ... but back in 19 days later

  const facts = await buildCorpFacts(entity.id, FY2025);
  assert.equal(facts.capitalGainEvents.some((e) => e.stopLossReleasedFrom), false);
  assert.equal(facts.suspendedCapitalLosses?.[0].releasedOn, null);
});

test('a partial repurchase suspends only the matched units', async () => {
  const { entity, trade } = await seedCorp();
  await trade('buy', '2025-01-10', 100, 2000);
  await trade('sell', '2025-03-01', 100, 1500); // loss 500 on 100 units
  await trade('buy', '2025-03-15', 40, 640);     // 40 units back

  const facts = await buildCorpFacts(entity.id, FY2025);
  assert.equal(facts.capitalGainEvents[0].stopLossSuspended?.toFixed(2), '200.00');
  assert.equal(netGains(facts.capitalGainEvents).toFixed(2), '-300.00');
});
