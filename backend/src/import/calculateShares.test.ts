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
