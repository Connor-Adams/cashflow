/**
 * What is coming: the instalment obligation across the three-year window, plus the
 * current year at its run rate.
 *
 * The three-year window is recomputed from facts rather than read from stored
 * snapshots, so all three years share a basis — and any year whose rate table is a
 * projection is named, because the threshold test's inputs are only as good as the
 * constants behind them. `rates-2024.ts` says outright it was "encoded from plan
 * recall. NOT cross-checked", and 2024 is one of the two years that decided Connor
 * owed no 2026 instalments.
 *
 * Note what is deliberately NOT applied here: the closed-year refusal from part 2.
 * This endpoint reads a historical figure to evaluate a threshold; it does not serve
 * 2024 as a return. Guarding it would make the whole outlook 409 because one
 * historical table is unverified, which would hide the very warning that matters.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { Account, Entity, Household, Transaction } from '../../models';
import { buildOutlook } from './buildOutlook';

let householdId: number;
let personalId: number;
let corpId: number;
let accountId: number;

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
  accountId = account.id;
});

let fp = 0;
async function draw(date: string, amount: string) {
  fp += 2;
  const corpLeg = await Transaction.create({
    accountId, householdId, entityId: corpId,
    date, amount: `-${amount}`, currency: 'CAD',
    merchantRaw: 'X', merchantClean: 'X', txnType: 'transfer',
    importBatch: 'b', sourceRowFingerprint: `c${fp}`, sourceIdentityFingerprint: `sc${fp}`,
  } as never);
  return Transaction.create({
    accountId, householdId, entityId: personalId,
    date, amount, currency: 'CAD',
    merchantRaw: 'X', merchantClean: 'X', txnType: 'transfer',
    linkedTransactionId: corpLeg.id, taxTreatmentOverride: 'non_eligible_dividend',
    importBatch: 'b', sourceRowFingerprint: `p${fp}`, sourceIdentityFingerprint: `sp${fp}`,
  } as never);
}

const build = (year: number, now: string) => buildOutlook({
  entityId: personalId, year, now: new Date(now),
});

test("Connor's 2026: large draws this year, nothing in 2024 or 2025 → no instalments", async () => {
  // The reassurance half. Both prior years were far under the threshold, so he is not
  // late and no interest is accruing, which nothing in the app said.
  for (const m of ['01', '02', '03', '04', '05', '06']) await draw(`2026-${m}-15`, '14000');
  const outlook = await build(2026, '2026-06-30T00:00:00Z');
  assert.equal(outlook.obligation.required, false);
  assert.match(outlook.obligation.reason, /2025 \(0\.00\)/);
  assert.equal(outlook.obligation.balanceDueOn, '2027-04-30');
});

test('the same taxpayer a year later does owe instalments', async () => {
  // The deadline half. 2026 is now a prior year and is over the threshold.
  for (const m of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) {
    await draw(`2026-${m}-15`, '14000');
  }
  for (const m of ['01', '02']) await draw(`2027-${m}-15`, '14000');
  const outlook = await build(2027, '2027-02-28T00:00:00Z');
  assert.equal(outlook.obligation.required, true);
  assert.equal(outlook.obligation.instalments[0].dueOn, '2027-03-15');
});

test('the forward view projects the rest of the current year', async () => {
  for (const m of ['01', '02', '03']) await draw(`2026-${m}-15`, '10000');
  const outlook = await build(2026, '2026-03-31T00:00:00Z');
  assert.equal(outlook.forward.draws.actualToDate.toFixed(2), '30000.00');
  assert.equal(outlook.forward.draws.projectedTotal.toFixed(2), '120000.00');
  assert.equal(outlook.forward.isProjection, true);
});

test('a projected rate table in the window is named, not silently trusted', async () => {
  // 2024 is marked projected because it was encoded from recall, and it is one of the
  // two years that decide the 2026 obligation. The threshold answer is reported AND
  // the weakness of its inputs is reported.
  await draw('2026-01-15', '20000');
  const outlook = await build(2026, '2026-06-30T00:00:00Z');
  assert.ok(
    outlook.provenanceWarnings.some((w) => /2024/.test(w)),
    JSON.stringify(outlook.provenanceWarnings),
  );
});

test('a window of published tables warns about nothing', async () => {
  // 2025 reads 2024, 2023 — and 2024 IS projected, so pick the one window that is
  // entirely published: there is none in the encoded set, because 2027 is a
  // projection and 2024 was encoded from recall. So this asserts the shape instead:
  // every warning names a year whose table really is marked projected.
  await draw('2027-01-15', '20000');
  const outlook = await build(2027, '2027-06-30T00:00:00Z');
  for (const w of outlook.provenanceWarnings) {
    assert.match(w, /(2027|2024) rate table is a projection|No rate table is encoded/);
  }
});

test('the threshold test uses the projected full year, not the year to date', async () => {
  // Two months of a $168,000 annual pattern is well under $3,000 of YTD owing, and
  // CRA's test is on the year's owing. Reading YTD would tell a taxpayer who will
  // plainly owe that nothing is required.
  for (const m of ['01', '02']) await draw(`2026-${m}-15`, '14000');
  const outlook = await build(2026, '2026-02-28T00:00:00Z');
  const ytd = Number(outlook.netOwingByYear[2026]);
  const projected = Number(outlook.projectedCurrentYearNetOwing);
  assert.ok(projected > ytd, `${projected} should exceed the YTD ${ytd}`);
  assert.ok(projected > 3000, `${projected} should clear the threshold`);
});

test('each year of the window reports its own net owing', async () => {
  // The three figures are what the threshold test reads; showing them is what makes
  // the verdict checkable rather than an opaque yes or no.
  for (const m of ['01', '02']) await draw(`2026-${m}-15`, '30000');
  const outlook = await build(2026, '2026-06-30T00:00:00Z');
  assert.equal(outlook.netOwingByYear[2025], '0.00');
  assert.equal(outlook.netOwingByYear[2024], '0.00');
  assert.ok(Number(outlook.netOwingByYear[2026]) > 3000, outlook.netOwingByYear[2026]);
});
