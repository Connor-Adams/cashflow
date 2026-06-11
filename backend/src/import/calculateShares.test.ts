import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAmount,
  businessAmount,
  recomputeTransactionAmounts,
} from './calculateShares';

test('splitAmount: me gets full amount', () => {
  const r = splitAmount(-100, 'me', null, null);
  assert.equal(r.myShareAmount, -100);
  assert.equal(r.partnerShareAmount, 0);
});

test('splitAmount: shared 50/50', () => {
  const r = splitAmount(100, 'shared', 0.5, 0.5);
  assert.equal(r.myShareAmount, 50);
  assert.equal(r.partnerShareAmount, 50);
});

function closeTo(actual: number, want: number, msg?: string) {
  assert.ok(Math.abs(actual - want) < 1e-9, msg ?? `got ${actual}, want ~${want}`);
}

test('splitAmount: single-sided pctMe defaults partner to the complement', () => {
  const r = splitAmount(-100, 'shared', 0.8, null);
  closeTo(r.myShareAmount, -80);
  closeTo(r.partnerShareAmount, -20);
});

test('splitAmount: single-sided pctPartner defaults me to the complement', () => {
  const r = splitAmount(-100, 'shared', null, 0.3);
  closeTo(r.myShareAmount, -70);
  closeTo(r.partnerShareAmount, -30);
});

test('splitAmount: small single-sided pctMe is not inflated by a 0.5 default', () => {
  const r = splitAmount(-100, 'shared', 0.05, null);
  closeTo(r.myShareAmount, -5);
  closeTo(r.partnerShareAmount, -95);
});

test('splitAmount: both sides missing falls back to 50/50', () => {
  const r = splitAmount(100, 'shared', null, null);
  closeTo(r.myShareAmount, 50);
  closeTo(r.partnerShareAmount, 50);
});

test('splitAmount: both sides given renormalizes by their sum', () => {
  const r = splitAmount(100, 'shared', 0.6, 0.6);
  closeTo(r.myShareAmount, 50);
  closeTo(r.partnerShareAmount, 50);
});

/**
 * Simulate DECIMAL(14,4) persistence on Postgres: the driver sends the float's
 * decimal text and Postgres rounds it half away from zero at 4 places. (SQLite
 * stores the raw float, which is why this only bites in prod.)
 */
function pgDecimal4(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const s = Math.abs(x).toString();
  const [int, frac = ''] = s.split('.');
  const scaled = BigInt(int + frac.slice(0, 4).padEnd(4, '0'));
  const nextDigit = frac.length > 4 ? Number(frac[4]) : 0;
  return (sign * Number(nextDigit >= 5 ? scaled + 1n : scaled)) / 10_000;
}

test('splitAmount: shares survive DECIMAL(14,4) persistence as exact complements', () => {
  // Tie case: 0.50 at 0.5001/0.4999 puts both raw shares on a 5th-decimal
  // boundary (0.25005 / 0.24995); independent half-away-from-zero rounding
  // would persist 0.2501 + 0.2500 = 0.5001 ≠ 0.5000.
  const cases: Array<[number, number, number]> = [
    [0.5, 0.5001, 0.4999],
    [-0.5, 0.5001, 0.4999],
    [100.01, 1, 2], // thirds: repeating decimals on both sides
    [-33.33, 0.3333, 0.6667],
    [0.0001, 0.5, 0.5],
  ];
  for (const [amount, pctMe, pctPartner] of cases) {
    const r = splitAmount(amount, 'shared', pctMe, pctPartner);
    const my = pgDecimal4(r.myShareAmount);
    const partner = pgDecimal4(r.partnerShareAmount);
    assert.equal(
      Math.round(my * 10_000) + Math.round(partner * 10_000),
      Math.round(amount * 10_000),
      `persisted shares must sum to amount for ${amount} @ ${pctMe}/${pctPartner}: ` +
        `got ${my} + ${partner}`,
    );
  }
});

test('businessAmount respects flag', () => {
  assert.equal(businessAmount(-40, true), -40);
  assert.equal(businessAmount(-40, false), 0);
});

test('recomputeTransactionAmounts sets finals', () => {
  const t = {
    amount: -20,
    categoryOverride: null,
    autoCategory: 'Food',
    businessOverride: null,
    autoBusiness: true,
    splitOverride: null,
    autoSplitType: 'me',
    pctMeOverride: null,
    autoPctMe: null,
    pctPartnerOverride: null,
    autoPctPartner: null,
  };
  const out = recomputeTransactionAmounts(t);
  assert.equal(out.finalCategory, 'Food');
  assert.equal(out.finalBusiness, true);
  assert.equal(out.myShareAmount, -20);
});
